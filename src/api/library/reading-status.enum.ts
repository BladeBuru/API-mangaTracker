export enum ReadingStatus {
  ReadLater = 'readLater',
  Reading = 'reading',
  CaughtUp = 'caughtUp',
  Completed = 'completed',
}

export function isReadingStatus(value: string): value is ReadingStatus {
  return Object.values(ReadingStatus).includes(value as ReadingStatus);
}

export function getReadingStatus(): string[] {
  return Object.values(ReadingStatus);
}
