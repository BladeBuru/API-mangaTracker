import { HttpException, HttpStatus } from '@nestjs/common';

export class ChapterException extends HttpException {
  constructor(msg: string) {
    super(msg, HttpStatus.NOT_ACCEPTABLE);
  }
}
