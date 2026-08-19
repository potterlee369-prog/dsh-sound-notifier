// Host half: playback and completion detection live entirely in the browser
// (see src/client). This module exists so the entry is a valid cordis plugin
// row on the host plane; the web profile's client-modules scan picks up the
// `dsh.client` declaration from package.json and serves the browser bundle.
export const name = 'sound-notifier'

export const inject: string[] = []

export function apply(): void {
  // Nothing to do host-side: the client half owns the Web Audio engine,
  // session running→idle edge detection, and per-browser settings.
}
