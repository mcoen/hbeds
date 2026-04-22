#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-hbeds-cdph-app}"
ENV_NAME="${ENV_NAME:-hbeds-prod}"
REGION="${AWS_REGION:-${REGION:-us-west-2}}"
VERSION_LABEL="${VERSION_LABEL:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_PATH="${PACKAGE_PATH:-/tmp/${APP_NAME}-${VERSION_LABEL}.zip}"
INSTANCE_ROLE_NAME="${INSTANCE_ROLE_NAME:-aws-elasticbeanstalk-ec2-role}"
INSTANCE_PROFILE_NAME="${INSTANCE_PROFILE_NAME:-aws-elasticbeanstalk-ec2-role}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required."
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required."
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
S3_BUCKET="${S3_BUCKET:-${APP_NAME}-${ACCOUNT_ID}-${REGION}-deployments}"
S3_KEY="${APP_NAME}/${VERSION_LABEL}.zip"

echo "Ensuring EC2 instance role/profile for Elastic Beanstalk..."
if ! aws iam get-role --role-name "${INSTANCE_ROLE_NAME}" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "${INSTANCE_ROLE_NAME}" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
for policy_arn in \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker \
  arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy --role-name "${INSTANCE_ROLE_NAME}" --policy-arn "${policy_arn}" >/dev/null || true
done
if ! aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null
fi
ROLE_IN_PROFILE_COUNT="$(aws iam get-instance-profile \
  --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
  --query "length(InstanceProfile.Roles[?RoleName=='${INSTANCE_ROLE_NAME}'])" \
  --output text)"
if [[ "${ROLE_IN_PROFILE_COUNT}" == "0" ]]; then
  aws iam add-role-to-instance-profile \
    --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
    --role-name "${INSTANCE_ROLE_NAME}" >/dev/null
  sleep 10
fi

echo "Building frontend bundle..."
npm run build

echo "Creating deployment archive at ${PACKAGE_PATH}..."
rm -f "${PACKAGE_PATH}"
zip -r "${PACKAGE_PATH}" \
  Procfile \
  package.json \
  package-lock.json \
  server \
  shared \
  dist \
  data \
  -x "*.DS_Store" "data/*.tmp"

echo "Ensuring Elastic Beanstalk application exists (${APP_NAME})..."
APP_COUNT="$(aws elasticbeanstalk describe-applications \
  --application-names "${APP_NAME}" \
  --region "${REGION}" \
  --query 'length(Applications)' \
  --output text)"
if [[ "${APP_COUNT}" == "0" ]]; then
  aws elasticbeanstalk create-application \
    --application-name "${APP_NAME}" \
    --region "${REGION}" >/dev/null
fi

echo "Ensuring S3 bucket exists (${S3_BUCKET})..."
if ! aws s3api head-bucket --bucket "${S3_BUCKET}" >/dev/null 2>&1; then
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${S3_BUCKET}" --region "${REGION}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${S3_BUCKET}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" >/dev/null
  fi
fi

echo "Uploading package to S3..."
aws s3 cp "${PACKAGE_PATH}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" >/dev/null

echo "Creating Elastic Beanstalk application version (${VERSION_LABEL})..."
aws elasticbeanstalk create-application-version \
  --application-name "${APP_NAME}" \
  --version-label "${VERSION_LABEL}" \
  --source-bundle S3Bucket="${S3_BUCKET}",S3Key="${S3_KEY}" \
  --region "${REGION}" >/dev/null

ENV_COUNT="$(aws elasticbeanstalk describe-environments \
  --application-name "${APP_NAME}" \
  --environment-names "${ENV_NAME}" \
  --region "${REGION}" \
  --query "length(Environments[?Status!='Terminated'])" \
  --output text)"

if [[ "${ENV_COUNT}" == "0" ]]; then
  STACK_NAME="$(aws elasticbeanstalk list-available-solution-stacks \
    --region "${REGION}" \
    --query "reverse(sort(SolutionStacks[?contains(@, '64bit Amazon Linux 2023') && contains(@, 'Node.js 20')]))[0]" \
    --output text)"

  if [[ -z "${STACK_NAME}" || "${STACK_NAME}" == "None" ]]; then
    echo "Could not find a Node.js 20 Elastic Beanstalk solution stack in ${REGION}."
    echo "Create an environment manually, then rerun this script."
    exit 1
  fi

  echo "Creating environment (${ENV_NAME}) using ${STACK_NAME}..."
  aws elasticbeanstalk create-environment \
    --application-name "${APP_NAME}" \
    --environment-name "${ENV_NAME}" \
    --solution-stack-name "${STACK_NAME}" \
    --version-label "${VERSION_LABEL}" \
    --option-settings \
      Namespace=aws:autoscaling:launchconfiguration,OptionName=IamInstanceProfile,Value="${INSTANCE_PROFILE_NAME}" \
      Namespace=aws:elasticbeanstalk:application:environment,OptionName=API_PORT,Value=8080 \
      Namespace=aws:elasticbeanstalk:application:environment,OptionName=PORT,Value=8080 \
    --region "${REGION}" >/dev/null
else
  echo "Updating existing environment (${ENV_NAME})..."
  aws elasticbeanstalk update-environment \
    --environment-name "${ENV_NAME}" \
    --version-label "${VERSION_LABEL}" \
    --option-settings \
      Namespace=aws:autoscaling:launchconfiguration,OptionName=IamInstanceProfile,Value="${INSTANCE_PROFILE_NAME}" \
      Namespace=aws:elasticbeanstalk:application:environment,OptionName=API_PORT,Value=8080 \
      Namespace=aws:elasticbeanstalk:application:environment,OptionName=PORT,Value=8080 \
    --region "${REGION}" >/dev/null
fi

echo "Waiting for environment update to finish..."
aws elasticbeanstalk wait environment-updated \
  --environment-names "${ENV_NAME}" \
  --region "${REGION}"

APP_URL="$(aws elasticbeanstalk describe-environments \
  --application-name "${APP_NAME}" \
  --environment-names "${ENV_NAME}" \
  --region "${REGION}" \
  --query 'Environments[0].CNAME' \
  --output text)"

echo "Deployment complete."
echo "Environment URL: http://${APP_URL}"
