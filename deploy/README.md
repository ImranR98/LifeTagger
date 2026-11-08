# Deploying LifeTagger on srv0

This directory holds the Kubernetes template and the values you need to merge
into the Infra repo. The app design follows the same conventions as the other
srv0 apps: one template in `targets/srv0/k3s-apps/templates/`, a pinned image
digest, a NetworkPolicy, and `validate.sh` before deployment.

## 1. Publish the image

The GitHub workflow publishes:

```
ghcr.io/imranr98/lifetagger:latest
ghcr.io/imranr98/lifetagger:sha-<commit>
```

Get the digest:

```bash
docker buildx imagetools inspect ghcr.io/imranr98/lifetagger:latest
```

Replace the placeholder digest in `lifetagger.yaml`, or let Renovate update it
after the first Infra PR.

## 2. Add the template

```bash
cp deploy/lifetagger.yaml ~/Main/Infra/targets/srv0/k3s-apps/templates/lifetagger.yaml
```

## 3. Add values

Add these to the gitignored `~/Main/Infra/config/srv0/values.yaml` (and mirror
the placeholders in `config_template/values.yaml`):

```yaml
PUBLIC_HOSTS:
  # ... existing hosts ...
  - lifetagger

# Generate once with:
#   npx web-push generate-vapid-keys
LIFETAGGER_VAPID_PUBLIC_KEY: "replace"
LIFETAGGER_VAPID_PRIVATE_KEY: "replace"
LIFETAGGER_VAPID_SUBJECT: "mailto:you@example.com"

# Optional: extra extensions for unusual formats (comma-separated).
LIFETAGGER_EXTRA_IMAGE_EXT: ""
LIFETAGGER_EXTRA_VIDEO_EXT: ""
```

`lifetagger` must be in `PUBLIC_HOSTS` so it is included in the edge
certificate SANs. `validate.sh` checks route/SAN drift.

Authelia's existing admin catch-all already requires two-factor auth. To let a
non-admin group use the app, add a rule to `AUTHELIA_ACCESS_CONTROL_RULES`:

```yaml
AUTHELIA_ACCESS_CONTROL_RULES: |
  - domain: lifetagger.{{ .Values.SERVICES_DOMAIN }}
    policy: two_factor
    subject:
      - 'group:admins'
      - 'group:family'
```

The route intentionally omits `geoblock` so the daily habit still works while
travelling. Authelia and CrowdSec remain in front of it. Add the geoblock filter
if you would rather keep the usual country allowlist.

## 4. Deploy

```bash
cd ~/Main/Infra
bash scripts/validate.sh srv0
bash scripts/deploy.sh srv0
```

Then open `https://lifetagger.<SERVICES_DOMAIN>`, authenticate with Authelia,
choose the media subtree (usually `/media`), and let the background index run.

## Storage and permissions

- Media: existing `hostpath-main-node-media-pvc`, mounted read-write at
  `/media`. The container runs as `MY_UID`; that user must own/write the media
  files. Never run a recursive `chown` on the media tree.
- App data: `lifetagger-data-pvc` on `nfs-apps`, 50 GiB. It holds the SQLite
  index, thumbnails, previews, face models, metadata backups, and DB snapshots.
  The PVC is labelled `auto-backup`; thumbnails, previews, and models are
  excluded from backups because they are rebuildable.
- SQLite runs in rollback-journal mode because the database lives on NFS. Keep
  one replica and the `Recreate` strategy.
- Add unusual formats with `LIFETAGGER_EXTRA_IMAGE_EXT` or
  `LIFETAGGER_EXTRA_VIDEO_EXT` (comma-separated) in the deployment env, then
  rescan. `EXCLUDE_EXT` still wins.
- The daily DB snapshot (`VACUUM INTO`) lives in `/data/db-snapshots`.

## Face recognition

The image includes the local Human/InsightFace models. CPU inference is the
default and is intentionally on-demand for large libraries: photos and video
poster frames are scanned when they enter the daily batch or are opened. Video
detection does not scan every timeline frame. Set `FACE_SCAN_MODE=background`
in the deployment if you want a full catch-up scan; expect it to take a long
time for a six-figure library.

## PWA and push

The public HTTPS host is required for the service worker and Web Push. After
installation, enable notifications in Settings. On iPhone, add the PWA to the
Home Screen first (iOS 16.4+). Authelia session expiry may require a fresh login
when a notification is opened after a long break.

## Health and operations

- Readiness/liveness: `GET /api/health`.
- Index progress and counts: `GET /api/status`.
- Media root can be changed from Settings; keep it inside `/media` because that
  is the only allowed root in the deployment.
- The app writes XMP metadata and optional filename migrations. Restore the
  media from your normal backups if a mass operation needs to be rolled back;
  per-file metadata JSON snapshots are in `/data/metadata-backups`.
