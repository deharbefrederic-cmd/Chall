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
  clients.js          GET liste · POST création (registre des clients)
  clients/[id].js     PATCH modification · DELETE suppression
  _clients.js         table `clients` (créée automatiquement), validation
  photos/[id].js      GET · PUT · DELETE photo d'une fiche client (R2)
  stats.js            compteurs d'installation
  parametres.js       réglages communs de la paie (clôtures, primes)
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

## Onglet Clients

Un second onglet tient un registre partagé des clients : nom, adresse
(facultative) et infos libres (étage, bâtiment, interphone, où déposer…).
La recherche porte sur les trois champs. Si l'adresse correspond sans
ambiguïté à une fiche de l'onglet Codes, le code s'affiche sur la carte.

La table `clients` est créée toute seule à la première utilisation : rien
à exécuter dans la console D1. Comme les codes, les fiches se lisent et se
modifient hors ligne : les modifications partent d'elles-mêmes au retour
du réseau (badge « ⏳ À envoyer » en attendant). Une fiche ne peut être
supprimée que par son auteur ou par l'administrateur.

### Photos des fiches clients

Une photo par client (porte, boîte aux lettres, interphone), réduite sur le
téléphone vers 150 Ko avant l'envoi. Elles sont stockées dans Cloudflare R2.
Pour les activer (une seule fois, dans le tableau de bord) :

1. **R2 Object Storage** → Create bucket → nom `challivretou-photos`.
   Cloudflare peut demander d'enregistrer un moyen de paiement pour activer
   R2, même si l'usage reste dans l'offre gratuite (10 Go).
2. Projet Pages → **Settings → Bindings** → Add → R2 bucket →
   nom de variable `PHOTOS`, bucket `challivretou-photos`.
   Production **et** Preview.
3. Redéployer (Deployments → dernier déploiement → Retry deployment) :
   une liaison ne prend effet qu'au déploiement suivant.

Tant que la liaison n'existe pas, tout le reste fonctionne ; seule la photo
est refusée, avec un message.

Ce registre contient des données personnelles de tiers : n'y noter que ce
qui sert à la livraison. Photos : uniquement des lieux, jamais de personnes
ni l'intérieur d'un logement.

## Onglet Bacs

Compteur personnel pour la prime de bacs journalière (paliers 75, 100 et
150 bacs). Une livraison = un appui sur son nombre de bacs (+1 à +8, ou
« Autre nombre ») ; « Annuler » retire la dernière. Vibration et message
à chaque palier franchi. Le récap mensuel compte les jours par palier
atteint, permet de corriger un jour ou d'en saisir un oublié, et s'exporte
en CSV pour comparer avec la fiche de paie.

Primes brutes par jour, selon le palier le plus haut atteint (non
cumulées) : 15 € (75 bacs), 30 € (100), 60 € (150). Le total du mois est
converti en net estimé avec un taux de cotisations réglable (22 % par
défaut) et, en option, le taux personnel de prélèvement à la source.
Montants et paliers : constantes `PALIERS` et `PRIMES_BRUT` dans `app.js`.

Le récap suit la **période de paie**. La clôture changeant chaque mois,
n'importe quel livreur saisit sa date exacte en touchant les dates de la
période (« clôture confirmée ») ; elle vaut pour toute l'équipe, la paie
suivante commence le lendemain, et la fenêtre indique qui l'a saisie et
quand. Modifier ou effacer une date existante demande une confirmation. Sans date saisie, un jour habituel est utilisé
(« clôture estimée » ; 31 = fin de mois).

**Primes exceptionnelles** journalières, cumulables avec la prime de bacs :
RCM (Roquebrune-Cap-Martin), GBT (Gambetta), DRL (Déroulède), CRN
(Corniche), 15 € brut par jour chacune. Le livreur coche celles du jour ;
l'administrateur peut changer les montants (⚙️ Réglages) pour toute l'équipe.

Réglages communs (clôtures, jour habituel, montants) : route
`/api/parametres`, table `parametres` créée automatiquement. Clôtures et
jour habituel modifiables par tous ; montants des primes avec la clé
d'administration seulement.

Les comptages restent **sur le téléphone** (stockage du navigateur) : rien
n'est envoyé au serveur. Vider les données du site ou changer de téléphone
les efface : exporter chaque mois pour en garder une copie.

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
