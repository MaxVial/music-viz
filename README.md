# Music-Vidz — What your music looks like

Une balade de nuit dans une forêt en 3D, construite à partir de **mes dernières écoutes Last.fm**.
Chaque morceau a sa clairière avec une scène de teuf : un grand drap où est projetée la pochette,
des murs d'enceintes, une foule qui danse et des projecteurs qui balaient le ciel.
On marche entre les sapins d'une scène à l'autre, et la musique du morceau monte en fondu en
s'approchant.

Projet du cours Web Technologies : devoir « What your music looks like ».

## Lancer le projet

Il faut **Docker Desktop**, une clé d'API **Last.fm** et une clé d'API **YouTube Data v3**.

1. Copier le modèle de configuration, puis remplir les trois valeurs :

   ```bash
   cp .env.example .env
   ```

   | Variable          | Où l'obtenir |
   |-------------------|--------------|
   | `LASTFM_API_KEY`  | https://www.last.fm/api/account/create |
   | `LASTFM_USER`     | le nom du profil Last.fm à visualiser |
   | `YOUTUBE_API_KEY` | Google Cloud Console → activer « YouTube Data API v3 » → Identifiants → Clé API |

   `.env` est listé dans `.gitignore` : les clés ne sont jamais commitées.

2. Tout lancer :

   ```bash
   docker compose up
   ```

3. Ouvrir **http://localhost:8080**, puis cliquer sur **« Entrer dans la forêt »**.
   Ce clic sert aussi à autoriser le son : les navigateurs bloquent la musique tant que
   l'utilisateur n'a pas cliqué.

Commandes utiles :

```bash
docker compose logs api     # voir quand Last.fm et YouTube sont vraiment appelés
docker compose down         # tout arrêter (le cache Redis est conservé)
docker compose down -v      # tout arrêter ET vider le cache
```

## Utilisation

- La caméra avance seule de clairière en clairière. Chaque morceau est joué **en entier**,
  puis on repart vers la scène suivante.
- **Suivant →** : passer au morceau suivant.
- **Map** : la forêt vue de haut, avec toutes les pochettes. Cliquer sur une pochette
  téléporte directement devant sa scène.
- L'ordre des morceaux et le tracé du parcours changent à chaque chargement de la page.

## Architecture

```
navigateur ──► nginx (web, port 8080) ──► /           fichiers de web/
                                      ├─► /api/...    Flask (api) ──► Last.fm, YouTube
                                      │                    │
                                      │                    └──► Redis (db) : le cache
                                      └─► /covers/... i.ytimg.com (pochettes)
```

`compose.yaml` lance trois services :

| Service | Image | Rôle |
|---------|-------|------|
| `web` | `nginx:alpine` | sert la page (`web/`) et relaie `/api/` vers Flask et `/covers/` vers les miniatures YouTube (`nginx.conf`) |
| `api` | `python:3.14-alpine` + Flask | la route `GET /tracks` : appelle Last.fm et YouTube, met les réponses en cache |
| `db`  | `redis:alpine` | le cache, enregistré dans un volume pour survivre aux redémarrages |

**Le navigateur ne parle qu'à mon serveur.** Les données (`/api/tracks`) et les images
(`/covers/…`) passent toutes par nginx. Les clés d'API restent dans le conteneur `api`, lues
depuis `.env` grâce à `env_file`. Seule exception : le lecteur YouTube officiel (IFrame API),
qui doit être chargé depuis YouTube pour jouer la musique. L'audio n'est jamais téléchargé.

Faire passer les pochettes par nginx a une autre raison : WebGL refuse d'utiliser comme
texture une image venant d'un autre site si ce site ne l'autorise pas explicitement.

## La route `GET /api/tracks`

1. Récupère les **200 dernières écoutes** de Last.fm (`user.getRecentTracks`) et enlève les doublons
   (même artiste et même titre).
2. Pour chaque morceau, cherche une vidéo YouTube intégrable (`search.list`, `type=video`,
   `videoEmbeddable=true`, 5 résultats). Une vidéo n'est gardée que si son titre ou sa chaîne
   contient **le nom de l'artiste et le titre du morceau**.
3. Ne renvoie que les morceaux trouvés : pas de pochette par défaut.

```json
{
  "user": "…",
  "lastfm": "cache",
  "count": 28,
  "warning": null,
  "tracks": [
    { "artist": "…", "title": "…", "videoId": "…", "thumbnail": "https://i.ytimg.com/vi/…", "playedAt": 1795000000 }
  ]
}
```

`playedAt` est l'heure de l'écoute en secondes Unix. Il vaut `null` si le morceau est en cours d'écoute.

### Le cache (Redis)

| Clé | Durée | Pourquoi |
|-----|-------|----------|
| `lastfm:recent` | 60 s | deux rechargements rapides ne font qu'**un seul** appel à Last.fm. Le champ `"lastfm"` de la réponse vaut `"cache"` ou `"lastfm"` |
| `youtube:<artiste>\|<titre>` | pour toujours | une recherche YouTube coûte 100 unités sur un quota de 10 000 par jour. Les morceaux **non trouvés** sont aussi gardés (`null`), pour ne pas les rechercher à nouveau |

### Quand quelque chose échoue

L'API renvoie toujours un JSON `{"error": "…"}`, avec un message en français que la page affiche
tel quel. Par exemple :

- clé manquante dans `.env` ;
- Last.fm qui ne répond pas, ou qui refuse la clé ;
- quota YouTube épuisé. Si une partie des morceaux est déjà trouvée, la page les affiche avec
  un avertissement (`warning`) au lieu d'une erreur ;
- Redis arrêté.

## La scène 3D (`web/scene.js`)

Tout est écrit en JavaScript avec **Three.js**, chargé depuis un CDN (version 0.170.0 fixée dans
l'`importmap` de `web/index.html`). Il n'y a pas d'étape de compilation, et aucun modèle 3D ni
aucune image n'est téléchargé : tout est construit dans le code.

- **Forêt** : des milliers de sapins (3 cônes fusionnés), dessinés avec un `InstancedMesh`,
  c'est-à-dire une seule forme répétée par la carte graphique. Il y a aussi de l'herbe, des
  racines et des pierres. La texture du sol est dessinée dans un `canvas`.
- **Parcours** : une courbe de Catmull-Rom qui slalome entre les arbres. La caméra la suit et
  regarde dans sa direction, puis se tourne vers chaque scène en arrivant. Aucun arbre ne
  pousse à moins de 1,3 m de la courbe.
- **Lumières** : un clair de lune avec des ombres, et des projecteurs colorés qui flashent au
  tempo. Pour rester fluide, il n'y a que 2 jeux de 4 projecteurs, qui suivent les 2 scènes les
  plus proches. Des faisceaux balaient aussi le ciel au-dessus des scènes.
- **Son** : deux lecteurs YouTube se passent le relais pour faire un fondu enchaîné. Le
  morceau suivant démarre à mi-chemin et monte jusqu'à l'arrivée devant le drap.
- **Tempo** : fixé à 160 BPM. On ne peut pas analyser le son d'un lecteur YouTube, donc les
  danseurs et les flashs ne suivent pas le vrai rythme du morceau.
- **Responsive** : la scène remplit toujours la fenêtre, et la carte se met à la verticale sur
  téléphone.

## Fichiers

```
api/app.py            serveur Flask : route /tracks, appels Last.fm / YouTube, cache, erreurs
api/Dockerfile        image python:3.14-alpine
api/requirements.txt  flask, redis, requests
web/index.html        la page : écran d'entrée, bandeau, lecteurs YouTube, carte
web/scene.js          toute la scène 3D
nginx.conf            fichiers statiques + relais /api/ et /covers/
compose.yaml          les trois services web, api, db
.env.example          modèle des variables d'environnement (sans valeurs)
tools/                scripts de test qui ont servi à choisir YouTube plutôt que Deezer
```

`tools/` contient les tests faits avant de coder. Last.fm ne fournit pas de pochette pour ces
morceaux de tribe/hardtek, écoutés sur SoundCloud et envoyés à Last.fm avec l'extension Web
Scrobbler. Deezer n'en trouvait que 4 sur 17, YouTube 12 sur 18. Pour les relancer :

```bash
docker run --rm --env-file .env -v "${PWD}/tools:/tools" python:3.14-alpine python /tools/youtube_coverage.py
```

## Crédits

- Données d'écoute : [Last.fm API](https://www.last.fm/api)
- Vidéos, miniatures et lecteur : [YouTube Data API v3](https://developers.google.com/youtube/v3) et [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
- 3D : [Three.js](https://threejs.org) (licence MIT), via [jsDelivr](https://www.jsdelivr.com)
- Les pochettes et la musique appartiennent à leurs artistes et sont affichées via YouTube.
