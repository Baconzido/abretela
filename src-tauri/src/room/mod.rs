//! A sala: servidor local (WebSocket + sinalização) e a página do convite.

pub mod commands;
pub mod invite_page;
pub mod server;
pub mod turn;

#[cfg(test)]
mod server_tests;
