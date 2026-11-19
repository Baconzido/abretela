//! TURN do anfitrião (ROADMAP, seção 4.4): o que precisa sair do WebView.
//! A Cloudflare só entrega credenciais temporárias pela API (com o token do
//! anfitrião), e a chamada é feita aqui para não depender de CORS. O token
//! nunca vai para a sala; só a credencial temporária, por `create_room`.

use serde_json::{json, Value};
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

/// Pede à Cloudflare uma credencial temporária de TURN e devolve os
/// `iceServers` como vieram (o WebView confere e filtra).
#[tauri::command]
pub async fn turn_cloudflare(key_id: String, token: String, ttl: u64) -> Result<Value, String> {
    let key_id = key_id.trim();
    if !valid_key_id(key_id) {
        return Err("the Key ID should have only letters and numbers".into());
    }
    let ttl = ttl.clamp(600, 48 * 60 * 60);
    // o reqwest sem provedor de criptografia usa o padrão do processo; falha
    // aqui só quer dizer que já havia um instalado
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("could not start the HTTP client: {e}"))?;
    let response = client
        .post(format!("{CLOUDFLARE_API}/{key_id}/credentials/generate-ice-servers"))
        .bearer_auth(token.trim())
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
    match body.get("iceServers") {
        Some(servers) if servers.is_array() || servers.is_object() => Ok(servers.clone()),
        _ => Err("Cloudflare's answer has no iceServers".into()),
    }
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
    async fn turn_cloudflare_reaches_the_api() {
        let err = turn_cloudflare("0123456789abcdef".into(), "token-falso".into(), 3600).await.unwrap_err();
        println!("{err}");
        assert!(err.contains("HTTP"), "{err}");
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
