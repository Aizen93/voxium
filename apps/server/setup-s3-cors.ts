import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const s3 = new S3Client({
  endpoint: process.env.S3_ASSETS_ENDPOINT!,
  region: process.env.S3_ASSETS_REGION!,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

await s3.send(
  new PutBucketCorsCommand({
    Bucket: process.env.S3_ASSETS_BUCKET!,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ['http://localhost:8080', 'https://localhost', 'https://voxium.app'],
          AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
          AllowedHeaders: ['*'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);

console.log('S3 CORS configuration updated successfully.');
