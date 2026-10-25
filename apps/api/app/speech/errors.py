class SpeechError(Exception):
    """Base class for expected speech pipeline failures."""


class SpeechProviderNotConfigured(SpeechError):
    pass


class SpeechProviderUnavailable(SpeechError):
    pass


class SpeechProviderRejected(SpeechError):
    pass


class TranscriptionEmpty(SpeechError):
    pass


class SynthesisEmpty(SpeechError):
    pass
