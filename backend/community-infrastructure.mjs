/** Staff and pilot fans have separate Cognito pools; private rooms remain unsigned. */
const ref = Ref => ({Ref});
const sub = value => ({'Fn::Sub': value});
export const STAFF_REDIRECT_URI = 'https://www.sameend.com/manage.html';
export const FAN_REDIRECT_URI = 'https://www.sameend.com/fan-signin.html';
export const FAN_SCOPE = 'sameend-community/use';
export const STAFF_GROUPS = Object.freeze(['sameend-admin', 'sameend-support', 'sameend-moderator', 'sameend-editor']);

/** Merge into the control template without mutating it or weakening fan routes. */
export function addCommunityInfrastructure(baseTemplate) {
  const template = structuredClone(baseTemplate);
  const resources = template.Resources;
  for (const [name, type] of [['Api', 'AWS::ApiGatewayV2::Api'], ['Integration', 'AWS::ApiGatewayV2::Integration'], ['Control', 'AWS::Lambda::Function']]) {
    if (resources?.[name]?.Type !== type) throw new Error(`Community infrastructure requires ${name} (${type})`);
  }
  if (resources.StaffUserPool) throw new Error('Community infrastructure already installed');
  const issuer = sub('https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${StaffUserPool}');
  // Stack UUID is lower-case, unique per stack/account/region and keeps the prefix below 63 characters.
  const domainPrefix = {'Fn::Join': ['-', ['sameend', ref('AWS::AccountId'), {'Fn::Select': [2, {'Fn::Split': ['/', ref('AWS::StackId')]}]}]]};
  const domain = sub('https://${StaffDomain}.auth.${AWS::Region}.amazoncognito.com');
  const fanIssuer = sub('https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${FanUserPool}');
  const fanDomain = sub('https://${FanDomain}.auth.${AWS::Region}.amazoncognito.com');
  Object.assign(resources, {
    StaffUserPool: {Type: 'AWS::Cognito::UserPool', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      UserPoolName: sub('${AWS::StackName}-staff'), DeletionProtection: 'ACTIVE',
      AdminCreateUserConfig: {AllowAdminCreateUserOnly: true},
      MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UsernameConfiguration: {CaseSensitive: false}, UsernameAttributes: ['email'], AutoVerifiedAttributes: ['email'],
      AccountRecoverySetting: {RecoveryMechanisms: [{Name: 'admin_only', Priority: 1}]},
      Policies: {PasswordPolicy: {MinimumLength: 14, RequireLowercase: true, RequireUppercase: true, RequireNumbers: true, RequireSymbols: true, TemporaryPasswordValidityDays: 3}},
      Schema: [{Name: 'email', AttributeDataType: 'String', Required: true, Mutable: true}]
    }},
    StaffClient: {Type: 'AWS::Cognito::UserPoolClient', Properties: {
      UserPoolId: ref('StaffUserPool'), ClientName: 'Same End staff browser', GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'], AllowedOAuthScopes: ['openid', 'email', 'aws.cognito.signin.user.admin'],
      SupportedIdentityProviders: ['COGNITO'], CallbackURLs: [STAFF_REDIRECT_URI], LogoutURLs: [STAFF_REDIRECT_URI],
      DefaultRedirectURI: STAFF_REDIRECT_URI, EnableTokenRevocation: true, PreventUserExistenceErrors: 'ENABLED',
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'], AuthSessionValidity:15, IdTokenValidity: 15, AccessTokenValidity: 15, RefreshTokenValidity: 1,
      TokenValidityUnits: {IdToken: 'minutes', AccessToken: 'minutes', RefreshToken: 'days'}
    }},
    StaffEnrollmentClient: {Type:'AWS::Cognito::UserPoolClient',Properties:{UserPoolId:ref('StaffUserPool'),ClientName:'Same End authenticator enrollment only',GenerateSecret:false,AllowedOAuthFlowsUserPoolClient:false,ExplicitAuthFlows:['ALLOW_USER_PASSWORD_AUTH'],AuthSessionValidity:15,PreventUserExistenceErrors:'ENABLED',EnableTokenRevocation:true,IdTokenValidity:5,AccessTokenValidity:5,RefreshTokenValidity:1,TokenValidityUnits:{IdToken:'minutes',AccessToken:'minutes',RefreshToken:'days'}}},
    StaffDomain: {Type: 'AWS::Cognito::UserPoolDomain', Properties: {UserPoolId: ref('StaffUserPool'), Domain: domainPrefix, ManagedLoginVersion: 1}},
    StaffAuthorizer: {Type: 'AWS::ApiGatewayV2::Authorizer', Properties: {
      ApiId: ref('Api'), Name: 'SameEndStaff', AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: {Audience: [ref('StaffClient')], Issuer: issuer}
    }},
    FanUserPool: {Type:'AWS::Cognito::UserPool',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{
      UserPoolName:sub('${AWS::StackName}-pilot-fans'),UserPoolTier:'LITE',DeletionProtection:'ACTIVE',
      AdminCreateUserConfig:{AllowAdminCreateUserOnly:false},MfaConfiguration:'OFF',
      UsernameConfiguration:{CaseSensitive:false},UsernameAttributes:['email'],AutoVerifiedAttributes:['email'],
      AccountRecoverySetting:{RecoveryMechanisms:[{Name:'verified_email',Priority:1}]},
      Policies:{PasswordPolicy:{MinimumLength:12,RequireLowercase:true,RequireUppercase:true,RequireNumbers:true,RequireSymbols:false}},
      Schema:[{Name:'email',AttributeDataType:'String',Required:true,Mutable:true}],
      VerificationMessageTemplate:{DefaultEmailOption:'CONFIRM_WITH_CODE',EmailSubject:'Verify your Same End pilot account',EmailMessage:'Your Same End pilot verification code is {####}.'}
    }},
    FanResourceServer:{Type:'AWS::Cognito::UserPoolResourceServer',Properties:{UserPoolId:ref('FanUserPool'),Identifier:'sameend-community',Name:'Same End pilot forum',Scopes:[{ScopeName:'use',ScopeDescription:'Use your pilot forum account'}]}},
    FanClient:{Type:'AWS::Cognito::UserPoolClient',DependsOn:'FanResourceServer',Properties:{
      UserPoolId:ref('FanUserPool'),ClientName:'Same End pilot browser',GenerateSecret:false,
      AllowedOAuthFlowsUserPoolClient:true,AllowedOAuthFlows:['code'],AllowedOAuthScopes:['openid','email',FAN_SCOPE],
      SupportedIdentityProviders:['COGNITO'],CallbackURLs:[FAN_REDIRECT_URI],LogoutURLs:[FAN_REDIRECT_URI],DefaultRedirectURI:FAN_REDIRECT_URI,
      ExplicitAuthFlows:['ALLOW_REFRESH_TOKEN_AUTH','ALLOW_USER_SRP_AUTH'],EnableTokenRevocation:true,PreventUserExistenceErrors:'ENABLED',
      IdTokenValidity:60,AccessTokenValidity:60,RefreshTokenValidity:1,TokenValidityUnits:{IdToken:'minutes',AccessToken:'minutes',RefreshToken:'days'}
    }},
    FanDomain:{Type:'AWS::Cognito::UserPoolDomain',Properties:{UserPoolId:ref('FanUserPool'),ManagedLoginVersion:1,Domain:{'Fn::Join':['-',['sameend-fans',ref('AWS::AccountId'),{'Fn::Select':[2,{'Fn::Split':['/',ref('AWS::StackId')]}]}]]}}},
    FanAuthorizer:{Type:'AWS::ApiGatewayV2::Authorizer',Properties:{ApiId:ref('Api'),Name:'SameEndPilotFans',AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],JwtConfiguration:{Audience:[ref('FanClient')],Issuer:fanIssuer}}}
  });
  STAFF_GROUPS.forEach((group, i) => {
    resources[`StaffGroup${i}`] = {Type: 'AWS::Cognito::UserPoolGroup', Properties: {GroupName: group, UserPoolId: ref('StaffUserPool'), Description: `Same End ${group.slice(8)} staff access`}};
  });
  for (const [name, path] of [['StaffAdminRoute', '/v1/community/admin/{proxy+}'], ['StaffAdminBaseRoute', '/v1/community/admin']]) {
    resources[name] = {Type: 'AWS::ApiGatewayV2::Route', Properties: {
      ApiId: ref('Api'), RouteKey: `ANY ${path}`, AuthorizationType: 'JWT', AuthorizerId: ref('StaffAuthorizer'),
      Target: {'Fn::Join': ['/', ['integrations', ref('Integration')]]}
    }};
  }
  for(const [name,path] of [['FanMemberRoute','/v1/community/member/{proxy+}'],['FanMemberBaseRoute','/v1/community/member']]){
    resources[name]={Type:'AWS::ApiGatewayV2::Route',Properties:{ApiId:ref('Api'),RouteKey:`ANY ${path}`,AuthorizationType:'JWT',AuthorizerId:ref('FanAuthorizer'),AuthorizationScopes:[FAN_SCOPE],Target:{'Fn::Join':['/',['integrations',ref('Integration')]]}}};
  }
  // Browser preflight carries no bearer token. Explicit OPTIONS routes take
  // precedence over the protected ANY routes without opening application methods.
  for (const [name, path] of [
    ['StaffAdminPreflightRoute', '/v1/community/admin/{proxy+}'],
    ['StaffAdminBasePreflightRoute', '/v1/community/admin'],
    ['FanMemberPreflightRoute', '/v1/community/member/{proxy+}'],
    ['FanMemberBasePreflightRoute', '/v1/community/member']
  ]) {
    resources[name] = {Type: 'AWS::ApiGatewayV2::Route', Properties: {
      ApiId: ref('Api'), RouteKey: `OPTIONS ${path}`, AuthorizationType: 'NONE',
      Target: {'Fn::Join': ['/', ['integrations', ref('Integration')]]}
    }};
  }
  const control = resources.Control.Properties;
  control.Environment ??= {};
  control.Environment.Variables ??= {};
  Object.assign(control.Environment.Variables, {
    COMMUNITY_ADMIN_ISSUER: issuer, COMMUNITY_ADMIN_CLIENT_ID: ref('StaffClient'),
    COMMUNITY_ADMIN_DOMAIN: domain, COMMUNITY_ADMIN_REDIRECT_URI: STAFF_REDIRECT_URI,COMMUNITY_ENROLLMENT_CLIENT_ID:ref('StaffEnrollmentClient'),
    COMMUNITY_FAN_ISSUER:fanIssuer,COMMUNITY_FAN_CLIENT_ID:ref('FanClient'),COMMUNITY_FAN_DOMAIN:fanDomain,COMMUNITY_FAN_REDIRECT_URI:FAN_REDIRECT_URI,COMMUNITY_FAN_SCOPE:FAN_SCOPE
  });
  template.Outputs = {...template.Outputs,
    StaffUserPoolId: {Value: ref('StaffUserPool')}, StaffIssuer: {Value: issuer}, StaffClientId: {Value: ref('StaffClient')},
    StaffDomain: {Value: domain}, StaffRedirectUri: {Value: STAFF_REDIRECT_URI},StaffEnrollmentClientId:{Value:ref('StaffEnrollmentClient')},
    FanUserPoolId:{Value:ref('FanUserPool')},FanIssuer:{Value:fanIssuer},FanClientId:{Value:ref('FanClient')},FanDomain:{Value:fanDomain},FanRedirectUri:{Value:FAN_REDIRECT_URI}
  };
  return template;
}
