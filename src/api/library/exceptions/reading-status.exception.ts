import { HttpException, HttpStatus } from '@nestjs/common';

export class ReadingStatusException extends HttpException {
  constructor(msg: string) {
    super(msg, HttpStatus.NOT_ACCEPTABLE);
  }
}
