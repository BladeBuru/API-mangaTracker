import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  DocumentBuilder,
  SwaggerDocumentOptions,
  SwaggerModule,
} from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger:
      process.env.NODE_ENV === 'development' ? ['debug'] : ['error', 'warn'],
  });

  // 1. Helmet — headers de sécurité (CSP, HSTS, X-Frame-Options, etc.)
  app.use(helmet());

  // 2. CORS — whitelist explicite par environnement
  // En dev : toutes origines autorisées (Flutter emulator, browser local)
  // En prod : seules les origines listées dans CORS_ORIGINS (séparées par virgules)
  if (process.env.NODE_ENV === 'development') {
    app.enableCors();
  } else {
    const corsOrigins = (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.enableCors({
      origin: corsOrigins.length > 0 ? corsOrigins : false,
      credentials: true,
    });
  }

  const configService = app.get(ConfigService);

  // 3. Validation stricte
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
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

  // 4. Swagger — désactivé en production
  if (process.env.NODE_ENV !== 'production') {
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
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        methodKey,
    };
    const document = SwaggerModule.createDocument(app, config, options);
    SwaggerModule.setup('api', app, document);
  }

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

bootstrap().then(() => {
  const logger = new Logger('Initialization');
  logger.log('Server started at http://localhost:3000');
  if (process.env.NODE_ENV !== 'production') {
    logger.log('API documentation can be found at http://localhost:3000/api');
  }
});
