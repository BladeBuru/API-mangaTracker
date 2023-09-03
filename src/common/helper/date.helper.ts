export class DateHelper {
  static deltaDays(d1: Date, d2: Date): number {
    const timeDifference = this.deltaTime(d1, d2);
    return timeDifference / (1000 * 3600 * 24);
  }

  static deltaTime(d1: Date, d2: Date): number {
    return Math.abs(d1.getTime() - d2.getTime());
  }
}
