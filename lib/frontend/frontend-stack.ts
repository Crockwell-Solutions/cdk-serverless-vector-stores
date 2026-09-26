/*
 * CDK Stack - Frontend Resources
 *
 * This CDK stack sets up the frontend resources for the CDK Serverless Vector Stores Project
 * This contains the S3 bucket for hosting the React application and the CloudFront distribution for serving it.
 *
 * Copyright Crockwell Solutions Limited
 */

import { Construct } from 'constructs';
import { Duration, Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  CachedMethods,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { execSync } from 'child_process';
import * as path from 'path';
import { EnvironmentConfig, Stage } from '@config';

export interface FrontendStackProps extends StackProps {
  stage: Stage;
  envConfig: EnvironmentConfig;
  userPoolId: string;
  userPoolClientId: string;
}

export class FrontendStack extends Stack {
  public distribution: Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // Create an S3 bucket to host the React application
    const websiteBucket = new Bucket(this, `${props.envConfig.project}WebsiteBucket`, {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const apiUrl = `https://${props.envConfig.apiDomainName}`;
    const apiOrigin = new URL(apiUrl).origin;
    const cognitoEndpoint = `https://cognito-idp.${props.envConfig.env.region}.amazonaws.com`;
    const cspKeyword = (keyword: string): string => `'${keyword}'`;
    const cspSelf = cspKeyword('self');
    const cspNone = cspKeyword('none');
    const cspUnsafeInline = cspKeyword('unsafe-inline');
    const contentSecurityPolicy = [
      `default-src ${cspSelf}`,
      `base-uri ${cspSelf}`,
      `object-src ${cspNone}`,
      `frame-ancestors ${cspNone}`,
      `form-action ${cspSelf}`,
      `script-src ${cspSelf}`,
      `style-src ${cspSelf} ${cspUnsafeInline} https://fonts.googleapis.com`,
      `font-src ${cspSelf} data: https://fonts.gstatic.com`,
      [
        `img-src ${cspSelf} data: blob:`,
        'https://server.arcgisonline.com',
        'https://basemaps.cartocdn.com',
        'https://tile.openstreetmap.org',
        'https://maps.crockwell.com',
      ].join(' '),
      [
        `connect-src ${cspSelf}`,
        'data:',
        'blob:',
        apiOrigin,
        cognitoEndpoint,
        'https://server.arcgisonline.com',
        'https://basemaps.cartocdn.com',
        'https://tile.openstreetmap.org',
        'https://maps.crockwell.com',
        'https://nominatim.openstreetmap.org',
      ].join(' '),
      `worker-src ${cspSelf} blob:`,
      'upgrade-insecure-requests',
    ].join('; ');

    const frontendSecurityHeaders = new ResponseHeadersPolicy(this, `${props.envConfig.project}FrontendHeaders`, {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
            override: true,
          },
        ],
      },
    });

    const staticAssetCachePolicy = new CachePolicy(this, `${props.envConfig.project}StaticAssetCachePolicy`, {
      comment: 'Cache immutable Vite assets without varying on viewer-controlled input',
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(1),
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    const websiteOrigin = S3BucketOrigin.withOriginAccessControl(websiteBucket);

    // Create CloudFront distribution
    this.distribution = new Distribution(this, `${props.envConfig.project}WebsiteDistribution`, {
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: websiteOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: frontendSecurityHeaders,
      },
      additionalBehaviors: {
        'assets/*': {
          origin: websiteOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: staticAssetCachePolicy,
          responseHeadersPolicy: frontendSecurityHeaders,
        },
        'config.js': {
          origin: websiteOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: frontendSecurityHeaders,
        },
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    });

    // Build and deploy the React application (excluding config.js — deployed separately)
    const frontendPath = path.join(__dirname, '../../frontend');

    const websiteDeployment = new BucketDeployment(this, `${props.envConfig.project}WebsiteDeployment`, {
      sources: [
        Source.asset(frontendPath, {
          bundling: {
            image: cdk.DockerImage.fromRegistry('node:22'),
            command: [
              'bash',
              '-c',
              'npm install && npm run build && rm -f dist/config.js && cp -r dist/* /asset-output/',
            ],
            local: {
              tryBundle(outputDir: string): boolean {
                execSync('npm install', {
                  cwd: frontendPath,
                  stdio: 'inherit',
                });
                execSync('npm run build', {
                  cwd: frontendPath,
                  stdio: 'inherit',
                });
                // Remove the local dev config.js from the build output
                const distPath = path.join(frontendPath, 'dist');
                execSync(`rm -f ${path.join(distPath, 'config.js')}`);
                execSync(`cp -r ${distPath}/* ${outputDir}`, {
                  stdio: 'inherit',
                });
                return true;
              },
            },
          },
        }),
      ],
      destinationBucket: websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: false,
    });

    // Deploy runtime config as a separate BucketDeployment.
    // All values are now static strings (no CloudFormation tokens), so Source.data() works.
    const configContent = `window.__RUNTIME_CONFIG__ = ${JSON.stringify(
      {
        apiUrl,
        cognitoUserPoolId: props.userPoolId,
        cognitoClientId: props.userPoolClientId,
        cognitoRegion: props.envConfig.env.region,
        adminMode: true,
      },
      null,
      2,
    )};\n`;

    const configDeployment = new BucketDeployment(this, `${props.envConfig.project}ConfigDeployment`, {
      sources: [Source.data('config.js', configContent)],
      destinationBucket: websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/config.js'],
      prune: false,
    });

    configDeployment.node.addDependency(websiteDeployment);

    // Output the CloudFront distribution domain name
    this.exportValue(this.distribution.distributionDomainName, {
      name: `${props.envConfig.project}CloudFrontDistributionDomainName`,
      description: `The domain name of the CloudFront distribution for the ${props.envConfig.project} Platform`,
    });
  }
}
