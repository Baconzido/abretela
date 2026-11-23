//! Codificador H.264 do Linux (OpenH264, no processador).
//!
//! Ainda sem o codificador de verdade: `open` recusa, e o envio nativo avisa
//! no log que não conseguiu codificar.

use super::{EncoderConfig, OnEncoded, VideoEncoder};
use crate::capture::{contracts::BoxError, packet::VideoPacket};
use std::time::Duration;

pub struct OpenH264Encoder;

impl OpenH264Encoder {
    pub fn open(_config: EncoderConfig, _on_encoded: OnEncoded) -> Result<Self, BoxError> {
        Err("o codificador de vídeo ainda não existe no Linux".into())
    }
}

impl VideoEncoder for OpenH264Encoder {
    fn describe(&self) -> String {
        "OpenH264 (processor)".into()
    }

    fn hardware(&self) -> bool {
        false
    }

    fn encode(&mut self, _frame: &VideoPacket, _timestamp: Duration, _keyframe: bool) -> Result<(), BoxError> {
        Err("o codificador de vídeo ainda não existe no Linux".into())
    }

    fn set_bitrate(&mut self, _bps: u32) {}
}
