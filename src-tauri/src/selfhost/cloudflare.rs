//! A API REST da Cloudflare, só o que o servidor próprio precisa: achar a
//! conta, o subdomínio `workers.dev`, a chave do TURN e subir, atualizar e
//! apagar o Worker. Tudo com o token que a pessoa colou (nunca vai para o
//! Worker nem para a sala).

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fmt, time::Duration};

const API: &str = "https://api.cloudflare.com/client/v4";

/// "Não existe" na API da Cloudflare (ex.: conta ainda sem subdomínio).
const NOT_FOUND: i64 = 10007;

/// Uma resposta de erro da Cloudflare, com o que ela disse.
#[derive(Debug)]
pub struct CfError {
    pub status: u16,
    pub code: Option<i64>,
    pub message: String,
}

impl fmt::Display for CfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Some(code) => write!(f, "{} (Cloudflare code {code}, HTTP {})", self.message, self.status),
            None => write!(f, "{} (HTTP {})", self.message, self.status),
        }
    }
}

impl CfError {
    fn local(message: impl Into<String>) -> Self {
        Self { status: 0, code: None, message: message.into() }
    }
    /// O token não tem a permissão para isto.
    pub fn is_forbidden(&self) -> bool {
        self.status == 401 || self.status == 403 || self.code == Some(10000)
    }
}

pub type CfResult<T> = Result<T, CfError>;

#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<ApiError>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct ApiError {
    code: i64,
    message: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct TurnKey {
    pub uid: String,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
struct Script {
    id: String,
}

#[derive(Deserialize)]
struct Subdomain {
    subdomain: String,
}

pub struct Cloudflare {
    client: reqwest::Client,
    token: String,
}

/// Ids e nomes vão na URL: só letras, números, `-` e `_`.
fn safe(part: &str) -> CfResult<&str> {
    if !part.is_empty() && part.len() <= 128 && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(part)
    } else {
        Err(CfError::local(format!("invalid name for the Cloudflare API: {part:?}")))
    }
}

impl Cloudflare {
    pub fn new(token: &str) -> CfResult<Self> {
        let token = token.trim();
        if token.is_empty() || token.len() > 512 || token.chars().any(|c| c.is_whitespace()) {
            return Err(CfError::local("the Cloudflare token looks invalid"));
        }
        // o reqwest sem provedor de criptografia usa o padrão do processo
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| CfError::local(format!("could not start the HTTP client: {e}")))?;
        Ok(Self { client, token: token.to_string() })
    }

    async fn send<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder) -> CfResult<Option<T>> {
        let response = req
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| CfError::local(format!("could not reach Cloudflare: {e}")))?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let envelope: Envelope<T> = match serde_json::from_str(&text) {
            Ok(e) => e,
            // apagar às vezes responde sem corpo
            Err(_) if (200..300).contains(&status) && text.trim().is_empty() => return Ok(None),
            Err(_) => {
                return Err(CfError { status, code: None, message: format!("unreadable answer from Cloudflare: {}", text.chars().take(200).collect::<String>()) })
            }
        };
        if !envelope.success || !(200..300).contains(&status) {
            let first = envelope.errors.into_iter().next();
            return Err(CfError {
                status,
                code: first.as_ref().map(|e| e.code),
                message: first.map(|e| e.message).unwrap_or_else(|| "Cloudflare refused the request".into()),
            });
        }
        Ok(envelope.result)
    }

    async fn result<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder) -> CfResult<T> {
        self.send(req).await?.ok_or_else(|| CfError::local("Cloudflare's answer is missing the result"))
    }

    /// As contas que o token alcança (também confere se o token vale).
    pub async fn accounts(&self) -> CfResult<Vec<Account>> {
        self.result(self.client.get(format!("{API}/accounts?per_page=50"))).await
    }

    /// O `<nome>` de `<nome>.workers.dev` da conta, se ela já tiver um.
    pub async fn subdomain(&self, account: &str) -> CfResult<Option<String>> {
        let account = safe(account)?;
        match self.result::<Subdomain>(self.client.get(format!("{API}/accounts/{account}/workers/subdomain"))).await {
            Ok(s) if !s.subdomain.is_empty() => Ok(Some(s.subdomain)),
            Ok(_) => Ok(None),
            Err(e) if e.code == Some(NOT_FOUND) || e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn create_subdomain(&self, account: &str, name: &str) -> CfResult<String> {
        let account = safe(account)?;
        let s: Subdomain = self
            .result(self.client.put(format!("{API}/accounts/{account}/workers/subdomain")).json(&json!({ "subdomain": name })))
            .await?;
        Ok(s.subdomain)
    }

    pub async fn create_turn_key(&self, account: &str, name: &str) -> CfResult<TurnKey> {
        let account = safe(account)?;
        self.result(self.client.post(format!("{API}/accounts/{account}/calls/turn_keys")).json(&json!({ "name": name })))
            .await
    }

    pub async fn turn_keys(&self, account: &str) -> CfResult<Vec<TurnKey>> {
        let account = safe(account)?;
        self.result(self.client.get(format!("{API}/accounts/{account}/calls/turn_keys"))).await
    }

    pub async fn delete_turn_key(&self, account: &str, uid: &str) -> CfResult<()> {
        let (account, uid) = (safe(account)?, safe(uid)?);
        self.send::<Value>(self.client.delete(format!("{API}/accounts/{account}/calls/turn_keys/{uid}"))).await?;
        Ok(())
    }

    /// Sobe (cria ou substitui) o Worker: um módulo `worker.js` e os metadados.
    pub async fn upload_worker(&self, account: &str, script: &str, metadata: &Value, code: &str) -> CfResult<()> {
        let (account, script) = (safe(account)?, safe(script)?);
        let form = reqwest::multipart::Form::new()
            .part(
                "metadata",
                reqwest::multipart::Part::text(metadata.to_string())
                    .mime_str("application/json")
                    .map_err(|e| CfError::local(e.to_string()))?,
            )
            .part(
                "worker.js",
                reqwest::multipart::Part::text(code.to_string())
                    .file_name("worker.js")
                    .mime_str("application/javascript+module")
                    .map_err(|e| CfError::local(e.to_string()))?,
            );
        self.send::<Value>(self.client.put(format!("{API}/accounts/{account}/workers/scripts/{script}")).multipart(form))
            .await?;
        Ok(())
    }

    /// Liga o endereço `<script>.<subdomínio>.workers.dev`.
    pub async fn enable_workers_dev(&self, account: &str, script: &str) -> CfResult<()> {
        let (account, script) = (safe(account)?, safe(script)?);
        self.send::<Value>(
            self.client
                .post(format!("{API}/accounts/{account}/workers/scripts/{script}/subdomain"))
                .json(&json!({ "enabled": true, "previews_enabled": false })),
        )
        .await?;
        Ok(())
    }

    pub async fn set_secret(&self, account: &str, script: &str, name: &str, text: &str) -> CfResult<()> {
        let (account, script) = (safe(account)?, safe(script)?);
        self.send::<Value>(
            self.client
                .put(format!("{API}/accounts/{account}/workers/scripts/{script}/secrets"))
                .json(&json!({ "name": name, "text": text, "type": "secret_text" })),
        )
        .await?;
        Ok(())
    }

    pub async fn scripts(&self, account: &str) -> CfResult<Vec<String>> {
        let account = safe(account)?;
        let list: Vec<Script> = self.result(self.client.get(format!("{API}/accounts/{account}/workers/scripts"))).await?;
        Ok(list.into_iter().map(|s| s.id).collect())
    }

    /// Apaga o Worker e, com ele, a sala e os dados dela (`force`).
    pub async fn delete_script(&self, account: &str, script: &str) -> CfResult<()> {
        let (account, script) = (safe(account)?, safe(script)?);
        match self.send::<Value>(self.client.delete(format!("{API}/accounts/{account}/workers/scripts/{script}?force=true"))).await {
            Ok(_) => Ok(()),
            // já não existe
            Err(e) if e.code == Some(NOT_FOUND) || e.status == 404 => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_in_urls_are_plain() {
        assert!(safe("abretela-1a2b3c").is_ok());
        assert!(safe("0123456789abcdef0123456789abcdef").is_ok());
        assert!(safe("../accounts").is_err());
        assert!(safe("a b").is_err());
        assert!(safe("").is_err());
    }

    #[test]
    fn token_must_look_like_a_token() {
        assert!(Cloudflare::new("  abc_DEF-123  ").is_ok());
        assert!(Cloudflare::new("").is_err());
        assert!(Cloudflare::new("tem espaço").is_err());
    }

    #[test]
    fn errors_say_what_cloudflare_said() {
        let e = CfError { status: 403, code: Some(10000), message: "Authentication error".into() };
        assert_eq!(e.to_string(), "Authentication error (Cloudflare code 10000, HTTP 403)");
        assert!(e.is_forbidden());
    }
}
