//! Comandos do app para a sala: criar (servidor local + túnel), trocar a
//! senha do repasse (TURN) e fechar.

use super::{invite_page::InvitePage, server, turn};
use crate::tunnel;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// A sala aberta por este PC (no máximo uma).
struct OpenRoom {
    stop: tokio::sync::watch::Sender<bool>,
    tunnel: Box<dyn tunnel::Tunnel>,
    handle: server::RoomHandle,
}

#[derive(Default)]
pub struct RoomState {
    room: Mutex<Option<OpenRoom>>,
}

impl RoomState {
    /// Fecha a sala aberta, se houver (servidor e túnel).
    pub fn close(&self) {
        if let Some(mut room) = self.room.lock().unwrap().take() {
            let _ = room.stop.send(true);
            room.tunnel.close();
        }
    }

    /// Os servidores de repasse da sala aberta agora (`Null` sem sala).
    fn current_ice_servers(&self) -> serde_json::Value {
        let handle = self.room.lock().unwrap().as_ref().map(|r| r.handle.clone());
        handle.map(|h| h.ice_servers()).unwrap_or(serde_json::Value::Null)
    }
}

#[derive(Serialize)]
pub struct RoomInfo {
    port: u16,
    /// URL https pública da sala (o convite é ela + "#senha").
    url: String,
    password: String,
}

/// Senha numérica de 6 dígitos.
fn random_password() -> String {
    use std::hash::{BuildHasher, RandomState};
    let n = RandomState::new().hash_one(std::time::SystemTime::now()) % 1_000_000;
    format!("{n:06}")
}

#[tauri::command]
pub async fn create_room(
    state: State<'_, RoomState>,
    leases: State<'_, turn::Leases>,
    settings: server::RoomSettings,
    password: Option<String>,
    host_name: Option<String>,
    lang: Option<String>,
    // servidores de repasse (TURN) já prontos, com credencial temporária se houver
    ice_servers: Option<serde_json::Value>,
) -> Result<RoomInfo, String> {
    state.close();
    let ice_servers = turn::room_ice_servers(ice_servers);
    // senhas do repasse de salas anteriores (ou de tentativas que falharam)
    leases.revoke_except_later(&ice_servers);

    let password = password
        .map(|p| p.trim().chars().take(32).collect::<String>())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(random_password);
    log_info!(
        "room",
        "Creating a room (quality limits: {}p-{}p, {}-{} fps)",
        settings.min_height,
        settings.max_height,
        settings.min_fps,
        settings.max_fps
    );
    let page = InvitePage {
        host_name: host_name.unwrap_or_default().trim().chars().take(32).collect(),
        lang: lang.unwrap_or_default(),
    };
    let server = server::start(settings, password.clone(), page, ice_servers).await.map_err(|e| {
        log_error!("room", "Could not start the local room server: {e}");
        leases.revoke_except_later(&serde_json::Value::Null);
        format!("falha ao iniciar servidor: {e}")
    })?;
    let tunnel = match tunnel::open(server.port).await {
        Ok(t) => t,
        Err(e) => {
            log_error!("room", "Could not open the internet tunnel: {e}");
            let _ = server.stop.send(true);
            leases.revoke_except_later(&serde_json::Value::Null);
            return Err(e);
        }
    };
    let url = tunnel.public_url().to_string();
    log_info!("room", "Room is online at {url}");
    *state.room.lock().unwrap() = Some(OpenRoom { stop: server.stop, tunnel, handle: server.handle });
    Ok(RoomInfo { port: server.port, url, password })
}

/// O app do anfitrião renovou a senha do repasse (TURN): a sala manda a nova
/// para todos, e as antigas da Cloudflare são revogadas depois de um tempo
/// para quem usa o repasse trocar de rota.
#[tauri::command]
pub async fn update_room_ice_servers(
    app: AppHandle,
    state: State<'_, RoomState>,
    ice_servers: serde_json::Value,
) -> Result<(), String> {
    let ice_servers = turn::room_ice_servers(Some(ice_servers));
    let handle = state.room.lock().unwrap().as_ref().map(|r| r.handle.clone());
    let Some(handle) = handle else {
        // a sala fechou enquanto a senha nova era gerada
        app.state::<turn::Leases>().revoke_except_later(&serde_json::Value::Null);
        return Err("the room is closed".into());
    };
    if ice_servers.is_null() {
        return Err("invalid relay server (TURN) settings".into());
    }
    handle.set_ice_servers(ice_servers).await;
    log_info!(
        "room",
        "Sent everyone in the room a new relay server (TURN) password; the old one stops working in {} minutes",
        turn::REVOKE_GRACE.as_secs() / 60
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(turn::REVOKE_GRACE).await;
        // as que a sala aberta agora manda continuam valendo (pode ser outra
        // sala, se o anfitrião fechou e abriu uma nova nesse meio tempo)
        let keep = app.state::<RoomState>().current_ice_servers();
        app.state::<turn::Leases>().revoke_except_later(&keep);
    });
    Ok(())
}

#[tauri::command]
pub fn close_room(state: State<'_, RoomState>, leases: State<'_, turn::Leases>) {
    log_info!("room", "Closed the room");
    state.close();
    leases.revoke_except_later(&serde_json::Value::Null);
}
