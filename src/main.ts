import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  DocumentBuilder,
  SwaggerDocumentOptions,
  SwaggerModule,
} from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger:
      process.env.NODE_ENV === 'development' ? ['debug'] : ['error', 'warn'],
  });

  if (process.env.NODE_ENV === 'development') {
    app.enableCors();
  }

  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      enableDebugMessages: configService.get(
        'ENABLE_DEBUG_MESSAGES_FOR_API_CLIENT',
      ),
      stopAtFirstError: true,
      disableErrorMessages: configService.get(
        'DISABLE_ERROR_MESSAGES_FOR_API_CLIENT',
      ),
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Manga Tracker API')
    .setDescription(
      `Here is the documentation and specification of the Manga Tracker API. 
      Here you'll find all the currently available endpoints and how to use them.`,
    )
    .addBearerAuth()
    .setVersion('1.0')
    .build();
  const options: SwaggerDocumentOptions = {
    operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
  };
  const document = SwaggerModule.createDocument(app, config, options);
  SwaggerModule.setup('api', app, document);

  await app.listen(3000);
}

bootstrap().then(() => {
  const logger = new Logger('Initialization');
  logger.log('Server started at http://localhost:3000');
  logger.log('API documentation can be found at http://localhost:3000/api');
});
