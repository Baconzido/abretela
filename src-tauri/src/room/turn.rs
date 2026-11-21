//! TURN do anfitrião (ROADMAP, seção 4.4): o que precisa sair do WebView.
//! A Cloudflare só entrega credenciais temporárias pela API (com o token do
//! anfitrião), e a chamada é feita aqui para não depender de CORS. O token
//! nunca vai para a sala; só a credencial temporária, por `create_room`.
//!
//! Cada credencial da Cloudflare fica anotada (`Leases`) até ser revogada:
//! quando o app renova a senha da sala, a antiga é revogada depois de
//! `REVOKE_GRACE` (tempo para quem usa o repasse trocar de rota), e ao fechar
//! a sala ou o app todas são revogadas. Assim uma senha que vazou de dentro da
//! sala para de valer cedo.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

const CLOUDFLARE_API: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";

/// Tamanho máximo dos `iceServers` guardados na sala (vão em todo "welcome").
const MAX_ICE_SERVERS_BYTES: usize = 8 * 1024;

/// O Key ID vai na URL: só letras e números (é um hexadecimal).
fn valid_key_id(key_id: &str) -> bool {
    !key_id.is_empty() && key_id.len() <= 64 && key_id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Confere os `iceServers` que o app manda para a sala: lista JSON pequena.
/// Qualquer outra coisa vira "sem TURN" (a sala abre do mesmo jeito).
pub fn room_ice_servers(value: Option<Value>) -> Value {
    match value {
        Some(Value::Array(list)) if !list.is_empty() => {
            let value = Value::Array(list);
            if value.to_string().len() <= MAX_ICE_SERVERS_BYTES {
                value
            } else {
                log_warn!("room", "The relay server (TURN) settings are too big; the room will use direct connections only");
                Value::Null
            }
        }
        _ => Value::Null,
    }
}

/// Quanto tempo a senha antiga ainda vale depois de a sala receber a nova.
pub const REVOKE_GRACE: Duration = Duration::from_secs(120);

/// O usuário de uma credencial vai na URL de revogar: só letras e números.
fn valid_username(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && name.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Uma credencial da Cloudflare que ainda não foi revogada.
struct Lease {
    key_id: String,
    token: String,
    username: String,
}

/// As credenciais da Cloudflare entregues por este app e ainda não revogadas.
#[derive(Default)]
pub struct Leases(Mutex<Vec<Lease>>);

impl Leases {
    fn add(&self, key_id: &str, token: &str, username: String) {
        self.0.lock().unwrap().push(Lease { key_id: key_id.into(), token: token.into(), username });
    }

    /// Revoga todas, menos as que aparecem em `keep` (os `iceServers` que a
    /// sala está usando). Sem espera: roda em segundo plano.
    pub fn revoke_except_later(&self, keep: &Value) {
        let leases = self.take_except(keep);
        if !leases.is_empty() {
            tauri::async_runtime::spawn(revoke(leases));
        }
    }

    /// Revoga todas e espera (até alguns segundos), para quando o app fecha.
    pub fn revoke_all_now(&self) {
        let leases = self.take_except(&Value::Null);
        if leases.is_empty() {
            return;
        }
        tauri::async_runtime::block_on(async {
            if tokio::time::timeout(Duration::from_secs(4), revoke(leases)).await.is_err() {
                log_warn!("room", "Cloudflare took too long to revoke the relay server (TURN) passwords; they expire on their own");
            }
        });
    }

    fn take_except(&self, keep: &Value) -> Vec<Lease> {
        let keep = usernames(keep);
        let mut leases = self.0.lock().unwrap();
        let (kept, gone): (Vec<Lease>, Vec<Lease>) = leases.drain(..).partition(|l| keep.contains(&l.username));
        *leases = kept;
        gone
    }
}

/// Os usuários das credenciais numa lista de `iceServers`.
fn usernames(ice_servers: &Value) -> HashSet<String> {
    let list: Vec<&Value> = match ice_servers {
        Value::Array(list) => list.iter().collect(),
        Value::Object(_) => vec![ice_servers],
        _ => vec![],
    };
    list.into_iter().filter_map(|s| s.get("username")?.as_str().map(String::from)).collect()
}

fn http_client() -> Result<reqwest::Client, String> {
    // o reqwest sem provedor de criptografia usa o padrão do processo; falha
    // aqui só quer dizer que já havia um instalado
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("could not start the HTTP client: {e}"))
}

/// Revoga as credenciais na Cloudflare. Falhar não é grave: elas vencem sozinhas.
async fn revoke(leases: Vec<Lease>) {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            log_warn!("room", "Could not revoke the old relay server (TURN) passwords: {e}. They expire on their own");
            return;
        }
    };
    let mut revoked = 0;
    for lease in leases {
        let url = format!("{CLOUDFLARE_API}/{}/credentials/{}/revoke", lease.key_id, lease.username);
        match client.post(url).bearer_auth(&lease.token).send().await {
            // 404: a Cloudflare já não conhece (venceu ou já foi revogada)
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND => revoked += 1,
            Ok(r) => log_warn!(
                "room",
                "Cloudflare did not revoke an old relay server (TURN) password (HTTP {}); it expires on its own",
                r.status().as_u16()
            ),
            Err(e) => log_warn!(
                "room",
                "Could not reach Cloudflare to revoke an old relay server (TURN) password: {e}. It expires on its own"
            ),
        }
    }
    if revoked > 0 {
        log_info!("room", "Revoked {revoked} old relay server (TURN) password{}", if revoked == 1 { "" } else { "s" });
    }
}

/// Pede à Cloudflare uma credencial temporária de TURN e devolve os
/// `iceServers` como vieram (o WebView confere e filtra). A credencial fica
/// anotada para ser revogada depois.
#[tauri::command]
pub async fn turn_cloudflare(
    leases: tauri::State<'_, Leases>,
    key_id: String,
    token: String,
    ttl: u64,
) -> Result<Value, String> {
    let key_id = key_id.trim();
    let token = token.trim();
    if !valid_key_id(key_id) {
        return Err("the Key ID should have only letters and numbers".into());
    }
    let ttl = ttl.clamp(600, 48 * 60 * 60);
    let client = http_client()?;
    let response = client
        .post(format!("{CLOUDFLARE_API}/{key_id}/credentials/generate-ice-servers"))
        .bearer_auth(token)
        .json(&json!({ "ttl": ttl }))
        .send()
        .await
        .map_err(|e| format!("could not reach Cloudflare: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("Cloudflare refused the Key ID or API token (HTTP {})", status.as_u16()));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Cloudflare does not know this Key ID (HTTP 404)".into());
    }
    if !status.is_success() {
        return Err(format!("Cloudflare answered HTTP {}", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("unreadable answer from Cloudflare: {e}"))?;
    let servers = match body.get("iceServers") {
        Some(servers) if servers.is_array() || servers.is_object() => servers.clone(),
        _ => return Err("Cloudflare's answer has no iceServers".into()),
    };
    let names: Vec<String> = usernames(&servers).into_iter().filter(|u| valid_username(u)).collect();
    if names.is_empty() {
        log_warn!("room", "Cloudflare's relay server (TURN) password has no username; it cannot be revoked early, only expire");
    }
    for name in names {
        leases.add(key_id, token, name);
    }
    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_id_must_be_plain_letters_and_numbers() {
        assert!(valid_key_id("a1b2c3d4e5f6"));
        assert!(!valid_key_id(""));
        assert!(!valid_key_id("../../zones"));
        assert!(!valid_key_id("abc?x=1"));
        assert!(!valid_key_id(&"a".repeat(65)));
    }

    /// Manual (precisa de internet): HTTPS até a Cloudflare funciona e uma
    /// chave inventada é recusada com uma mensagem clara.
    #[tokio::test]
    #[ignore]
    async fn cloudflare_api_refuses_a_made_up_key() {
        let response = http_client()
            .unwrap()
            .post(format!("{CLOUDFLARE_API}/0123456789abcdef/credentials/generate-ice-servers"))
            .bearer_auth("token-falso")
            .json(&json!({ "ttl": 3600 }))
            .send()
            .await
            .unwrap();
        println!("{}", response.status());
        assert!(response.status().is_client_error());
    }

    #[test]
    fn leases_in_use_are_kept_and_the_rest_are_taken() {
        let leases = Leases::default();
        leases.add("k", "t", "velha".into());
        leases.add("k", "t", "nova".into());
        let room = json!([{ "urls": ["stun:x"] }, { "urls": ["turn:x"], "username": "nova", "credential": "p" }]);
        let gone: Vec<String> = leases.take_except(&room).into_iter().map(|l| l.username).collect();
        assert_eq!(gone, vec!["velha"]);
        let gone: Vec<String> = leases.take_except(&Value::Null).into_iter().map(|l| l.username).collect();
        assert_eq!(gone, vec!["nova"]);
        assert!(leases.take_except(&Value::Null).is_empty());
    }

    #[test]
    fn usernames_come_from_the_list_or_the_old_single_object() {
        let one = json!({ "urls": ["turn:x"], "username": "a", "credential": "p" });
        assert_eq!(usernames(&one), HashSet::from(["a".to_string()]));
        assert!(usernames(&json!([{ "urls": "stun:x" }])).is_empty());
        assert!(usernames(&Value::Null).is_empty());
        assert!(valid_username(&"ab12".repeat(24)));
        assert!(!valid_username("a/../b"));
    }

    #[test]
    fn room_keeps_only_a_small_non_empty_list() {
        let turn = json!([{ "urls": ["turn:t.example.com"], "username": "u", "credential": "p" }]);
        assert_eq!(room_ice_servers(Some(turn.clone())), turn);
        assert_eq!(room_ice_servers(None), Value::Null);
        assert_eq!(room_ice_servers(Some(json!([]))), Value::Null);
        assert_eq!(room_ice_servers(Some(json!({ "urls": "turn:x" }))), Value::Null);
        let huge = json!([{ "urls": ["turn:x"], "username": "u".repeat(9000), "credential": "p" }]);
        assert_eq!(room_ice_servers(Some(huge)), Value::Null);
    }
}
