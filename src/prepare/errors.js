export class PrepareJobCancelledError extends Error {
  constructor(message = 'cancelado pelo operador') {
    super(message);
    this.name = 'PrepareJobCancelledError';
  }
}
