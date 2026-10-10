// orchard-infra: Terraform for the cloud pieces, Kubernetes manifests for the API, and the feature flags file.
import { RepoBuilder, after, replace } from '../lib/gitworld.ts';
import { at, june, maya, remote, sam, theo } from './people.ts';

const append = (s: string) => (old: string) => old + s;

export function buildInfra() {
  const r = new RepoBuilder('orchard-infra', remote('orchard-infra'));

  const i1 = r.commit(null, 'Terraform for the database and network', {
    'README.md': `# orchard-infra

Everything Orchard runs on. Terraform (\`terraform/\`) owns the cloud resources; the API's Kubernetes
manifests live in \`k8s/\`; \`flags/flags.yaml\` is read by the API at startup.

Changes go through a PR like any code: CI runs \`terraform plan\` and posts it on the PR, and merging
to \`main\` applies it.
`,
    'terraform/main.tf': `terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  backend "s3" {
    bucket = "orchard-terraform-state"
    key    = "prod/terraform.tfstate"
    region = "eu-west-2"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "orchard", env = var.env }
  }
}
`,
    'terraform/variables.tf': `variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "env" {
  type    = string
  default = "prod"
}
`,
    'terraform/database.tf': `resource "aws_db_instance" "main" {
  identifier                  = "orchard-\${var.env}"
  engine                      = "postgres"
  engine_version              = "16.3"
  instance_class              = "db.t4g.medium"
  allocated_storage           = 50
  max_allocated_storage       = 200
  db_name                     = "orchard"
  username                    = "orchard"
  manage_master_user_password = true
  backup_retention_period     = 14
  deletion_protection         = true
  skip_final_snapshot         = false
}
`,
  }, { author: theo, at: at('2026-05-06 10:00') });

  const i2 = r.commit(i1, 'Deploy the API to the cluster', {
    'k8s/api/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orchard-api
  labels: { app: orchard-api }
spec:
  replicas: 3
  selector:
    matchLabels: { app: orchard-api }
  template:
    metadata:
      labels: { app: orchard-api }
    spec:
      containers:
        - name: api
          image: registry.orchard.example/orchard-api:latest
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef: { name: orchard-api }
            - secretRef: { name: orchard-api }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 256Mi }
`,
    'k8s/api/configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: orchard-api
data:
  PORT: "8080"
  SMTP_ADDR: "smtp.orchard.example:587"
  MAIL_FROM: "bookings@orchard.example"
`,
  }, { author: theo, at: at('2026-05-29 15:40') });

  const i3 = r.commit(i2, 'Add the feature flags file', {
    'flags/flags.yaml': `# Read by orchard-api at startup. A flag is off unless listed here.
# studios: [ids] turns a flag on for those studios only; all: true for everyone.
flags:
  class-spots-left:
    all: true
`,
    'k8s/api/configmap.yaml': append('  FLAGS_FILE: "/etc/orchard/flags.yaml"\n'),
  }, { author: june, at: at('2026-07-09 11:15') });

  const i4 = r.commit(i3, 'Alert when webhook deliveries pile up', {
    'k8s/api/alerts.yaml': `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: orchard-api
spec:
  groups:
    - name: payments
      rules:
        - alert: WebhookDeadLetters
          expr: orchard_webhook_dead_letters > 0
          for: 10m
          labels: { severity: page }
          annotations:
            summary: Payment webhooks are failing after every retry; members may be missing credits.
`,
  }, { author: sam, at: at('2026-08-07 14:30') });

  const i5 = r.commit(i4, 'Raise the API memory limit to 384Mi', {
    'k8s/api/deployment.yaml': replace('limits: { memory: 256Mi }', 'limits: { memory: 384Mi }'),
  }, { author: theo, at: at('2026-08-21 09:05') });

  // ---------------------------------------------------------------- Maya's waitlists branch
  const f1 = r.commit(i5, 'Run the hold-expiry sweep every five minutes', {
    'k8s/api/cronjobs.yaml': `apiVersion: batch/v1
kind: CronJob
metadata:
  name: orchard-sweep-holds
spec:
  # Expires waitlist offers nobody took within the hold window and offers the spot to the next
  # person in line (orchard-api: \`orchard-api sweep-holds\`). Holds are two hours, so a few minutes
  # of lateness is fine; Forbid stops a slow run from overlapping the next.
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 240
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: sweep
              image: registry.orchard.example/orchard-api:latest
              args: ["sweep-holds"]
              envFrom:
                - configMapRef: { name: orchard-api }
                - secretRef: { name: orchard-api }
              resources:
                requests: { cpu: 50m, memory: 64Mi }
                limits: { memory: 128Mi }
`,
  }, { author: maya, at: at('2026-09-11 17:05'), key: 'i1' });

  const f2 = r.commit(f1, 'Alert when promotions stop going out', {
    'k8s/api/alerts.yaml': append(`    - name: waitlists
      rules:
        - alert: HoldSweepFailing
          expr: time() - kube_cronjob_status_last_successful_time{cronjob="orchard-sweep-holds"} > 1800
          labels: { severity: ticket }
          annotations:
            summary: >-
              The hold-expiry sweep hasn't succeeded for 30 minutes. Expired offers aren't being
              passed on, so people further down waitlists aren't getting spots.
`),
  }, { author: maya, at: at('2026-09-12 09:40'), key: 'i2' });

  const f3 = r.commit(f2, 'Turn on waitlists for the beta studios', {
    'flags/flags.yaml': after('  class-spots-left:\n    all: true\n', `  waitlists:
    # the three studios that asked for it; everyone once we've watched a few weeks of promotions
    studios: [4, 11, 17]
`),
  }, { author: maya, at: at('2026-09-12 15:30'), key: 'i3' });

  r.ref('main', i5);
  r.ref('refs/remotes/origin/main', i5);
  r.ref('refs/remotes/origin/HEAD', i5);
  r.ref('maya/waitlists', f3);
  r.ref('maya/infra-sweep-cron', f1);
  r.ref('maya/infra-sweep-alert', f2);
  return r;
}
