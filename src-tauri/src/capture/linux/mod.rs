//! Captura no Linux: telas e janelas pelo portal do sistema
//! (xdg-desktop-portal) com o PipeWire, e o som do sistema pelo PipeWire.
//!
//! Ainda sem a captura de verdade: o app abre e assiste, mas não transmite.

use super::contracts::{AudioSource, AudioTarget, BoxError, FrameSink, RunningVideo, Source, SourceInfo, VideoConfig, VideoSource};
use std::sync::{atomic::AtomicBool, Arc};

/// Baixa a prioridade da thread atual, para a captura não disputar o
/// processador com o que está sendo transmitido.
pub fn lower_thread_priority() {
    // no Linux a prioridade (nice) vale por thread: 0 = a thread que chama
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

pub struct PortalSource;

impl VideoSource for PortalSource {
    fn list(&self) -> Vec<Source> {
        Vec::new()
    }

    fn thumbnail(&self, _id: &str) -> Option<String> {
        None
    }

    fn inspect(&self, _id: &str) -> Option<SourceInfo> {
        None
    }

    fn start(
        &self,
        _id: &str,
        _config: VideoConfig,
        _sink: Arc<dyn FrameSink>,
        _stop: Arc<AtomicBool>,
    ) -> Result<RunningVideo, String> {
        Err("a captura de tela ainda não existe no Linux".into())
    }
}

pub struct PipewireAudio;

impl AudioSource for PipewireAudio {
    fn run(&self, _target: AudioTarget, _sink: Arc<dyn FrameSink>, _stop: Arc<AtomicBool>) -> Result<(), BoxError> {
        Err("a captura de som ainda não existe no Linux".into())
    }
}
