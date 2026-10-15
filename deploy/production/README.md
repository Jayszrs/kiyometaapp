# Production deploy config (server 10.44.12.223)

Reference copy of what runs on the server. The live files are outside this repo:

| Repo file | Live location |
|---|---|
| docker-compose.yml, nginx-kiyometa.conf, auto-deploy.sh, ocr-fix/ | /srv/kiyometa/deploy/ |
| systemd/kiyometa-autodeploy.{service,timer} | /etc/systemd/system/ |

Secrets (secrets.env etc.) are not committed; compose reads them from the server.
auto-deploy.sh polls origin/main every minute and rebuilds orders-webapp and ocr.
Editing these copies does not change the server: copy them over by hand.
