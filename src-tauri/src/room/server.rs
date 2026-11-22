//! Servidor de sinalização: guarda quem está na sala e repassa as mensagens
//! WebRTC entre os participantes. Vídeo e áudio nunca passam por aqui.
//! Também serve a página do link de convite (`/`).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch, Mutex};

use super::invite_page::{InvitePage, RoomStats};

const LOGO_PNG: &[u8] = include_bytes!("../../icons/128x128@2x.png");

#[derive(Clone, Serialize)]
struct PeerInfo {
    id: String,
    name: String,
    sharing: bool,
    /// Ex.: "720p 60fps"
    label: Option<String>,
    /// Quem criou a sala (entrou com a chave do anfitrião). Versões antigas ignoram.
    owner: bool,
}

/// Endereço banido pelo anfitrião, até quando (só enquanto a sala existir).
struct Ban {
    ip: String,
    until: std::time::Instant,
}

/// Limite de um ban (uma semana), para um número absurdo não estourar o relógio.
const MAX_BAN_MINUTES: u64 = 7 * 24 * 60;

/// Limites de qualidade escolhidos por quem criou a sala.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    pub min_height: u32,
    pub max_height: u32,
    pub min_fps: u32,
    pub max_fps: u32,
}

struct Peer {
    info: PeerInfo,
    tx: mpsc::UnboundedSender<Message>,
    /// De onde veio, pelo túnel (vazio para o anfitrião, que é local).
    ip: String,
}

struct Hub {
    peers: Mutex<HashMap<String, Peer>>,
    /// Chave que só o app de quem criou a sala recebe: entra como anfitrião (kikar).
    host_key: String,
    bans: Mutex<Vec<Ban>>,
    next_id: AtomicU64,
    shutdown: watch::Receiver<bool>,
    settings: RoomSettings,
    password: String,
    page: InvitePage,
    /// Servidores de repasse (TURN) do anfitrião, mandados no "welcome". Mudam
    /// quando o anfitrião renova a senha temporária.
    ice_servers: std::sync::Mutex<Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ClientMsg {
    Join {
        name: String,
        #[serde(default)]
        password: String,
        /// Chave do anfitrião (só o app de quem criou a sala tem).
        #[serde(default)]
        admin: Option<String>,
    },
    Sharing { sharing: bool, label: Option<String> },
    Signal { to: String, data: Value },
    /// Só o anfitrião: tira alguém da sala (e, com `banMinutes`, não volta por esse tempo).
    Kick {
        id: String,
        #[serde(default, rename = "banMinutes")]
        ban_minutes: u64,
    },
}

pub struct RunningServer {
    pub port: u16,
    pub stop: watch::Sender<bool>,
    pub handle: RoomHandle,
    /// Para o app de quem criou a sala entrar como anfitrião.
    pub host_key: String,
}

fn random_key() -> String {
    use ring::rand::SecureRandom;
    let mut buf = [0u8; 24];
    ring::rand::SystemRandom::new().fill(&mut buf).expect("random numbers");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compara sem revelar pelo tempo onde a diferença está.
fn same_key(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Mexe na sala aberta por fora do WebSocket (o app do anfitrião).
#[derive(Clone)]
pub struct RoomHandle(Arc<Hub>);

impl RoomHandle {
    /// Troca os servidores de repasse (TURN) da sala e avisa todo mundo. Quem
    /// entrar depois já recebe os novos no "welcome".
    pub async fn set_ice_servers(&self, ice_servers: Value) {
        *self.0.ice_servers.lock().unwrap() = ice_servers.clone();
        let peers = self.0.peers.lock().await;
        broadcast(&peers, json!({ "type": "ice-servers", "iceServers": ice_servers }));
    }

    /// Os servidores de repasse que a sala está mandando agora.
    pub fn ice_servers(&self) -> Value {
        self.0.ice_servers.lock().unwrap().clone()
    }
}

pub async fn start(
    settings: RoomSettings,
    password: String,
    page: InvitePage,
    ice_servers: Value,
) -> std::io::Result<RunningServer> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (stop, stop_rx) = watch::channel(false);

    let host_key = random_key();
    let hub = Arc::new(Hub {
        peers: Mutex::new(HashMap::new()),
        host_key: host_key.clone(),
        bans: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(1),
        shutdown: stop_rx.clone(),
        settings,
        password,
        page,
        ice_servers: std::sync::Mutex::new(ice_servers),
    });
    let handle = RoomHandle(hub.clone());
    let app = Router::new()
        .route("/", get(invite_handler))
        .route("/logo.png", get(|| async { ([(header::CONTENT_TYPE, "image/png")], LOGO_PNG) }))
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(hub);

    let mut rx = stop_rx;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.wait_for(|stopped| *stopped).await;
            })
            .await;
    });

    Ok(RunningServer { port, stop, handle, host_key })
}

async fn invite_handler(headers: HeaderMap, State(hub): State<Arc<Hub>>) -> Html<String> {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    let stats = {
        let peers = hub.peers.lock().await;
        RoomStats { people: peers.len(), live: peers.values().filter(|p| p.info.sharing).count() }
    };
    Html(hub.page.render(host, stats))
}

async fn ws_handler(ws: WebSocketUpgrade, headers: HeaderMap, State(hub): State<Arc<Hub>>) -> impl IntoResponse {
    // pelo túnel, o cloudflared diz de onde a pessoa vem; o anfitrião (local) não tem
    let ip = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    ws.on_upgrade(move |socket| handle_socket(socket, hub, ip))
}

fn send(tx: &mpsc::UnboundedSender<Message>, value: Value) {
    let _ = tx.send(Message::Text(value.to_string().into()));
}

fn broadcast(peers: &HashMap<String, Peer>, value: Value) {
    let text = value.to_string();
    for peer in peers.values() {
        let _ = peer.tx.send(Message::Text(text.clone().into()));
    }
}

async fn handle_socket(socket: WebSocket, hub: Arc<Hub>, ip: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Escritor: envia as mensagens da fila e um ping periódico para o
    // Cloudflare não derrubar a conexão por inatividade.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(m) => if sink.send(m).await.is_err() { break },
                    None => break,
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() { break }
                }
            }
        }
        let _ = sink.close().await;
    });

    let mut shutdown = hub.shutdown.clone();
    let mut my_id: Option<String> = None;

    loop {
        let msg = tokio::select! {
            msg = stream.next() => msg,
            _ = shutdown.wait_for(|stopped| *stopped) => break,
        };
        let text = match msg {
            Some(Ok(Message::Text(t))) => t,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => continue,
        };
        let Ok(cmsg) = serde_json::from_str::<ClientMsg>(&text) else {
            continue;
        };

        match cmsg {
            ClientMsg::Join { name, password, admin } => {
                if my_id.is_some() {
                    continue;
                }
                let banned = !ip.is_empty() && {
                    let mut bans = hub.bans.lock().await;
                    bans.retain(|b| b.until > std::time::Instant::now());
                    bans.iter().any(|b| b.ip == ip)
                };
                if banned {
                    send(&tx, json!({ "type": "error", "reason": "banned" }));
                    break;
                }
                let owner = admin.as_deref().is_some_and(|k| same_key(k, &hub.host_key));
                if !owner && password.trim() != hub.password {
                    // atraso para dificultar tentativa e erro; depois desconecta
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    send(&tx, json!({ "type": "error", "reason": "wrong-password" }));
                    break;
                }
                let id = hub.next_id.fetch_add(1, Ordering::Relaxed).to_string();
                let mut name: String = name.trim().chars().take(32).collect();
                if name.is_empty() {
                    name = format!("Convidado {id}");
                }
                let info = PeerInfo { id: id.clone(), name, sharing: false, label: None, owner };

                let mut peers = hub.peers.lock().await;
                let others: Vec<PeerInfo> = peers.values().map(|p| p.info.clone()).collect();
                let mut welcome =
                    json!({ "type": "welcome", "id": id, "peers": others, "settings": hub.settings, "owner": owner });
                let ice_servers = hub.ice_servers.lock().unwrap().clone();
                if ice_servers.as_array().is_some_and(|a| !a.is_empty()) {
                    welcome["iceServers"] = ice_servers;
                }
                send(&tx, welcome);
                broadcast(&peers, json!({ "type": "peer-joined", "peer": info }));
                peers.insert(id.clone(), Peer { info, tx: tx.clone(), ip: ip.clone() });
                my_id = Some(id);
            }
            ClientMsg::Kick { id: target, ban_minutes } => {
                let Some(id) = &my_id else { continue };
                let mut peers = hub.peers.lock().await;
                if !peers.get(id).is_some_and(|p| p.info.owner) || target == *id {
                    continue;
                }
                let Some(gone) = peers.remove(&target) else { continue };
                let ban = ban_minutes.min(MAX_BAN_MINUTES);
                if ban > 0 && !gone.ip.is_empty() {
                    let until = std::time::Instant::now() + Duration::from_secs(ban * 60);
                    hub.bans.lock().await.push(Ban { ip: gone.ip.clone(), until });
                }
                send(&gone.tx, json!({ "type": "kicked", "banned": ban > 0 }));
                let _ = gone.tx.send(Message::Close(None));
                broadcast(&peers, json!({ "type": "peer-left", "id": target }));
                let note = if ban > 0 { " (banned)" } else { "" };
                log_info!("room", "The host removed {:?} from the room{note}", gone.info.name);
            }
            ClientMsg::Sharing { sharing, label } => {
                let Some(id) = &my_id else { continue };
                let label = label.filter(|_| sharing).map(|l| l.chars().take(48).collect::<String>());
                let mut peers = hub.peers.lock().await;
                if let Some(me) = peers.get_mut(id) {
                    me.info.sharing = sharing;
                    me.info.label = label.clone();
                }
                broadcast(
                    &peers,
                    json!({ "type": "peer-updated", "id": id, "sharing": sharing, "label": label }),
                );
            }
            ClientMsg::Signal { to, data } => {
                let Some(id) = &my_id else { continue };
                let peers = hub.peers.lock().await;
                if let Some(target) = peers.get(&to) {
                    send(&target.tx, json!({ "type": "signal", "from": id, "data": data }));
                }
            }
        }
    }

    if let Some(id) = my_id {
        let mut peers = hub.peers.lock().await;
        // kikado: já saiu da lista e os outros já foram avisados
        if peers.remove(&id).is_some() {
            broadcast(&peers, json!({ "type": "peer-left", "id": id }));
        }
    }
    drop(tx);
    let _ = writer.await;
    // Termina o fechamento lendo o que ainda chegar (ex.: o pong do primeiro
    // ping). Soltar o socket com dados não lidos faz o Windows mandar um RST,
    // e o outro lado pode perder a última mensagem (como a de senha errada).
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(msg)) = stream.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}
