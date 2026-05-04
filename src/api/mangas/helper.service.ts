import { Injectable } from '@nestjs/common';

@Injectable()
export class HelperService {
  formatRequestForMuApi(
    url: string,
    parameters: { [key: string]: string },
  ): string {
    let formattedRequest = url;
    let firstParameter = true;

    for (const key in parameters) {
      const currentParam = parameters[key];
      if (typeof currentParam !== 'undefined') {
        formattedRequest = formattedRequest.concat(
          (firstParameter ? '?' : '&') + key + '=' + currentParam,
        );
        firstParameter = false;
      }
    }
    return formattedRequest;
  }
}
