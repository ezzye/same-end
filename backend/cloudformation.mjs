const ref = Ref => ({Ref});
const sub = value => ({'Fn::Sub': value});
const attr = (resource, name) => ({'Fn::GetAtt': [resource, name]});
export const artifactTemplate = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Private Same End control deployment artifacts only',
  Resources: {
    Artifacts: {Type: 'AWS::S3::Bucket', Properties: {PublicAccessBlockConfiguration: {BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true}, BucketEncryption: {ServerSideEncryptionConfiguration: [{ServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}}]}, LifecycleConfiguration: {Rules: [{Id: 'ExpireOldCode', Status: 'Enabled', ExpirationInDays: 14, AbortIncompleteMultipartUpload: {DaysAfterInitiation: 1}}]}}},
    ArtifactPolicy: {Type: 'AWS::S3::BucketPolicy', Properties: {Bucket: ref('Artifacts'), PolicyDocument: {Version: '2012-10-17', Statement: [{Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [attr('Artifacts', 'Arn'), sub('${Artifacts.Arn}/*')], Condition: {Bool: {'aws:SecureTransport': false}}}]}}}
  }, Outputs: {Bucket: {Value: ref('Artifacts')}}
};
export const template = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Same End private room control and separate fan community; no match video',
  Parameters: {
    ArtifactBucket: {Type: 'String'}, ArtifactKey: {Type: 'String'},
    VapidPublicKey: {Type: 'String', AllowedPattern: '[A-Za-z0-9_-]{87}'},
    VapidPrivateKey: {Type: 'String', NoEcho: true, AllowedPattern: '[A-Za-z0-9_-]{43}'},
    EdgeTurnUrls: {Type: 'String', Default: ''}, EdgeTurnSecret: {Type: 'String', Default: '', NoEcho: true},
    EdgeTurnHealthSecret: {Type: 'String', Default: '', NoEcho: true}, EdgeTurnUplinkMbps: {Type: 'Number', Default: 0, MinValue: 0}, EdgeTurnAllocationLimit: {Type: 'Number', Default: 0, MinValue: 0}
  },
  Resources: {
    Clubs: {Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      BillingMode: 'PAY_PER_REQUEST', OnDemandThroughput: {MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50},
      AttributeDefinitions: [{AttributeName: 'pk', AttributeType: 'S'}, {AttributeName: 'sk', AttributeType: 'S'}, {AttributeName: 'gpk', AttributeType: 'S'}, {AttributeName: 'gsk', AttributeType: 'S'}],
      KeySchema: [{AttributeName: 'pk', KeyType: 'HASH'}, {AttributeName: 'sk', KeyType: 'RANGE'}],
      GlobalSecondaryIndexes: [{IndexName: 'due', KeySchema: [{AttributeName: 'gpk', KeyType: 'HASH'}, {AttributeName: 'gsk', KeyType: 'RANGE'}], Projection: {ProjectionType: 'KEYS_ONLY'}, OnDemandThroughput: {MaxReadRequestUnits: 10, MaxWriteRequestUnits: 25}}],
      TimeToLiveSpecification: {AttributeName: 'expiresAt', Enabled: true}, SSESpecification: {SSEEnabled: true},
      PointInTimeRecoverySpecification: {PointInTimeRecoveryEnabled: true}
    }},
    Logs: {Type: 'AWS::Logs::LogGroup', Properties: {LogGroupName: sub('/aws/lambda/${AWS::StackName}-control'), RetentionInDays: 7}},
    RuntimeRole: {Type: 'AWS::IAM::Role', Properties: {AssumeRolePolicyDocument: {Version: '2012-10-17', Statement: [{Effect: 'Allow', Principal: {Service: 'lambda.amazonaws.com'}, Action: 'sts:AssumeRole'}]}, Policies: [{PolicyName: 'OwnControlTableAndLogs', PolicyDocument: {Version: '2012-10-17', Statement: [
      {Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], Resource: [attr('Clubs', 'Arn'), sub('${Clubs.Arn}/index/due')]},
      {Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: attr('Logs', 'Arn')}
    ]}}]}},
    Control: {Type: 'AWS::Lambda::Function', DependsOn: ['Logs'], Properties: {
      FunctionName: sub('${AWS::StackName}-control'), Runtime: 'nodejs24.x', Handler: 'index.handler', Architectures: ['arm64'],
      MemorySize: 256, Timeout: 90, ReservedConcurrentExecutions: 5, Role: attr('RuntimeRole', 'Arn'),
      Code: {S3Bucket: ref('ArtifactBucket'), S3Key: ref('ArtifactKey')}, Environment: {Variables: {TABLE_NAME: ref('Clubs'), VAPID_PUBLIC_KEY: ref('VapidPublicKey'), VAPID_PRIVATE_KEY: ref('VapidPrivateKey'), EDGE_TURN_URLS: ref('EdgeTurnUrls'), EDGE_TURN_SECRET: ref('EdgeTurnSecret'), EDGE_TURN_HEALTH_SECRET: ref('EdgeTurnHealthSecret'), EDGE_TURN_UPLINK_MBPS: ref('EdgeTurnUplinkMbps'), EDGE_TURN_ALLOCATION_LIMIT: ref('EdgeTurnAllocationLimit')}}
    }},
    Api: {Type: 'AWS::ApiGatewayV2::Api', Properties: {Name: sub('${AWS::StackName}-api'), ProtocolType: 'HTTP', CorsConfiguration: {AllowOrigins: ['https://www.sameend.com'], AllowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], AllowHeaders: ['authorization', 'content-type'], MaxAge: 600}}},
    Integration: {Type: 'AWS::ApiGatewayV2::Integration', Properties: {ApiId: ref('Api'), IntegrationType: 'AWS_PROXY', IntegrationUri: attr('Control', 'Arn'), PayloadFormatVersion: '2.0', TimeoutInMillis: 15000}},
    Route: {Type: 'AWS::ApiGatewayV2::Route', Properties: {ApiId: ref('Api'), RouteKey: 'ANY /v1/{proxy+}', Target: {'Fn::Join': ['/', ['integrations', ref('Integration')]]}}},
    AnalyticsEventsRoute: {Type: 'AWS::ApiGatewayV2::Route', Properties: {ApiId: ref('Api'), RouteKey: 'POST /v1/analytics/events', AuthorizationType: 'NONE', Target: {'Fn::Join': ['/', ['integrations', ref('Integration')]]}}},
    Stage: {Type: 'AWS::ApiGatewayV2::Stage', Properties: {ApiId: ref('Api'), StageName: '$default', AutoDeploy: true, DefaultRouteSettings: {ThrottlingBurstLimit: 40, ThrottlingRateLimit: 20}}},
    HttpInvoke: {Type: 'AWS::Lambda::Permission', Properties: {FunctionName: ref('Control'), Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/v1/*')}},
    Reminders: {Type: 'AWS::Events::Rule', Properties: {Description: 'Same End best-effort private match reminders', ScheduleExpression: 'rate(1 minute)', State: 'ENABLED', Targets: [{Arn: attr('Control', 'Arn'), Id: 'ControlReminders', RetryPolicy: {MaximumEventAgeInSeconds: 600, MaximumRetryAttempts: 2}}]}},
    ScheduleInvoke: {Type: 'AWS::Lambda::Permission', Properties: {FunctionName: ref('Control'), Action: 'lambda:InvokeFunction', Principal: 'events.amazonaws.com', SourceArn: attr('Reminders', 'Arn')}}
  },
  Outputs: {ApiBase: {Value: attr('Api', 'ApiEndpoint')}}
};
