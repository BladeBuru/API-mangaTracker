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
  logger.log(
    `Server started at http://localhost:3000 in ${process.env.NODE_ENV} mode`,
  );
  logger.log('API documentation can be found at http://localhost:3000/api');
  if (process.env.NODE_ENV === 'development') {
    logger.log(`API PORT: ${process.env.PORT}`);
    logger.log(`NODE_ENV: ${process.env.NODE_ENV}`);

    logger.log(`DATABASE_HOST: ${process.env.DATABASE_HOST}`);
    logger.log(`DATABASE_NAME: ${process.env.DATABASE_NAME}`);
    logger.log(`DATABASE_USER: ${process.env.DATABASE_USER}`);
    logger.log(`DATABASE_PASSWORD: ${process.env.DATABASE_PASSWORD}`);
    logger.log(`DATABASE_PORT: ${process.env.DATABASE_PORT}`);
    logger.log(`DATABASE_SCHEMA: ${process.env.DATABASE_SCHEMA}`);

    logger.log(`JWT_REFRESH_SECRET: ${process.env.JWT_REFRESH_SECRET}`);
    logger.log(`JWT_KEY: ${process.env.JWT_KEY}`);
    logger.log(
      `JWT_REFRESH_SECRET_EXPIRES_IN: ${process.env.JWT_REFRESH_SECRET_EXPIRES_IN}`,
    );
    logger.log(`JWT_KEY_EXPIRES_IN: ${process.env.JWT_KEY_EXPIRES_IN}`);

    logger.log(`HTTP_TIMEOUT: ${process.env.HTTP_TIMEOUT}`);
    logger.log(`HTTP_MAX_REDIRECT: ${process.env.HTTP_MAX_REDIRECT}`);
    logger.log(
      `ENABLE_DEBUG_MESSAGES_FOR_API_CLIENT: ${process.env.ENABLE_DEBUG_MESSAGES_FOR_API_CLIENT}`,
    );
    logger.log(
      `DISABLE_ERROR_MESSAGES_FOR_API_CLIENT: ${process.env.DISABLE_ERROR_MESSAGES_FOR_API_CLIENT}`,
    );
    logger.log(`TYPEORM_DEBUG_LOGGING: ${process.env.TYPEORM_DEBUG_LOGGING}`);
  }
});
