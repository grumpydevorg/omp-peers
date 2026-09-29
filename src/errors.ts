/**
 * Error classes thrown by the peers extension.
 *
 * The class `name` doubles as a stable code the OMP wiring can branch on
 * (all names are unique and never minified away). `instanceof` also works.
 */

export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

export class PeerNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerNameError';
  }
}
