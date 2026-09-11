# Challivretou

Annuaire partagé de codes d'accès pour tournées de livraison.
PWA sans dépendance, hébergée sur Cloudflare Pages, données dans Cloudflare D1.

## Déploiement (tableau de bord Cloudflare)

Tout se fait dans le navigateur, sans ligne de commande.

1. **Base** — Dashboard → D1 SQL database → Create → nom `challivretou`.
2. **Schéma** — onglet Console de la base : coller le contenu de `schema.sql`, Execute.
3. **Secret** — projet Pages → Settings → Variables and Secrets → Add →
   nom `CHALL_KEY`, type Secret. À faire en Production **et** Preview.
4. **Liaison** — projet Pages → Settings → Bindings → Add → D1 database →
   nom de variable `DB`, base `challivretou`. Production **et** Preview.
5. **Code** — pousser les fichiers sur GitHub : le déploiement part tout seul.

Les étapes 3 et 4 doivent être faites **avant** l'étape 5, sinon l'API
répond 500 tant que le secret et la liaison n'existent pas.

Ne pas ajouter de `wrangler.toml` : sur un projet configuré depuis le
tableau de bord, ce fichier écrase les réglages et casse le déploiement.

Le binding KV `CODES_KV` peut être supprimé une fois la migration vérifiée.

## Utilisation : le lien d'invitation

Les livreurs ne saisissent jamais de clé. Vous leur envoyez un lien :

```
https://VOTRE-DOMAINE/#k=LA_CLE
```

Un clic depuis WhatsApp ou SMS ouvre l'application, enregistre la clé sur
l'appareil et efface la clé de la barre d'adresse. C'est tout. Les fois
suivantes, l'application s'ouvre directement, et l'icône installée sur
l'écran d'accueil fonctionne sans le lien.

La clé est dans le fragment (`#`), qui n'est jamais transmis au serveur :
elle n'apparaît dans aucun journal Cloudflare.

Pour retrouver ce lien sans le retaper, tapez `#lien` dans la barre de
recherche : il est copié dans le presse-papiers, prêt à être transféré.
Tapez `#stats` pour les compteurs d'installation.

Pour révoquer l'accès (livreur qui part, lien diffusé), changez `CHALL_KEY`
et renvoyez le nouveau lien à l'équipe.

## Architecture

```
/                     shell PWA (index.html, app.js, style.css, sw.js)
/functions/api/
  _middleware.js      vérifie X-Chall-Key sur toutes les routes /api
  _lib.js             validation, normalisation, limitation de débit
  codes.js            GET liste · POST création
  codes/[id].js       PATCH modification · DELETE suppression
  stats.js            compteurs d'installation
  ping.js             validation de clé
schema.sql            tables D1
tools/kv-to-sql.mjs   migration KV → D1
```

### Points de conception

- **Écritures unitaires.** Chaque modification ne touche qu'une ligne.
  Deux livreurs qui enregistrent en même temps ne s'écrasent plus.
- **Unicité en base.** Un index unique sur l'adresse normalisée empêche
  les doublons stricts, même en cas de requêtes simultanées.
- **Historique.** Toute modification ou suppression archive l'état
  précédent dans `codes_history` : rien n'est perdu définitivement.
- **Suppression contrôlée.** Vérifiée côté serveur : seul l'auteur, et
  seulement dans les 24 h suivant l'ajout.
- **Hors ligne.** Le service worker met en cache le shell, l'application
  garde la dernière liste connue et met les modifications en file
  d'attente, rejouées au retour du réseau. Les identifiants étant générés
  côté client, un rejeu ne crée jamais de doublon.
- **Limitation de débit.** 60 écritures par heure et par IP.

## Restriction d'accès complémentaire (recommandé)

La clé partagée empêche la lecture publique, mais elle circule entre
plusieurs personnes. Pour une base contenant des codes d'accès
d'immeubles, envisagez en plus, dans **Cloudflare Zero Trust → Access** :
une règle sur le domaine limitée à une liste d'adresses e-mail, avec
code à usage unique. Cela ajoute une authentification individuelle et un
journal des accès, sans modifier le code.

## Développement local

```bash
npx wrangler pages dev . --d1 DB=challivretou --binding CHALL_KEY=dev-key
```
