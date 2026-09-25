# GitLab Desk

> Progetto indipendente e non ufficiale, non affiliato né approvato da GitLab Inc. "GitLab" è un marchio registrato di GitLab Inc. ed è usato qui solo per indicare il servizio con cui l'app è compatibile.

Client desktop in stile GitHub Desktop per lavorare con un server GitLab aziendale (self-managed) o con gitlab.com.

Funzioni principali: elenco delle modifiche con diff e spunta dei file da includere, selezione multipla (Ctrl+clic, Maiusc+clic, frecce) con menu contestuale per scartare, ignorare con .gitignore (singoli file o per estensione), includere o escludere, copiare i percorsi e aprire i file nell'editor preferito o in Esplora risorse, commit con titolo e descrizione, annulla ultimo commit, scarta modifiche, cronologia con dettaglio dei commit in stile GitHub Desktop (elenco dei file del commit, diff del file scelto, anteprima prima/dopo delle immagini), branch (crea, rinomina, cambia, elimina anche dal server, checkout di branch remoti), menu Branch in stile GitHub Desktop con merge, squash e rebase nel branch attuale (con anteprima dei commit in arrivo e dei conflitti previsti), guida alla risoluzione dei conflitti, "Aggiorna da main", confronto tra branch, stash delle modifiche (anche automatico al cambio di branch, con la scelta tra lasciarle sul branch di partenza o portarle con sé, e vista dei file accantonati) e push forzato sicuro dopo un rebase, fetch/pull/push con conteggio dei commit da pubblicare e da scaricare, clonazione dai tuoi progetti GitLab o da URL, e merge request: elenco, dettaglio con stato di pipeline e approvazioni, creazione con revisori, bozza, squash ed eliminazione del branch dopo il merge. Se il branch non è ancora pubblicato, l'app fa il push da sola prima di creare la merge request.

## Due modi di lavorare

Ogni repository può usare il modo che preferisce, dal menu **Repository → Modo di lavoro**:

- **Con merge request**: l'app suggerisce di lavorare su un branch e di aprire una merge request verso il branch principale.
- **Push diretto sul branch principale**: niente suggerimenti sulle merge request; da un branch di lavoro il pulsante "Unisci in main" (menu Branch, Ctrl+Maiusc+I) aggiorna main, ci unisce il branch e propone il push. Si può anche lavorare e fare push direttamente su main.

In entrambi i modi tutte le funzioni restano disponibili. Se il branch principale è protetto in GitLab e il tuo ruolo non può pubblicarci, l'app lo segnala prima del push e spiega come abilitarlo.

## Requisiti

- Node.js 20 o successivo (solo per avviare e compilare l'app)
- Git 2.31 o successivo installato sul computer
- Un token di accesso personale GitLab con scope `api`, `read_repository` e `write_repository`

## Installazione

Scarica l'installer dalla pagina **Releases** del repository: `GitLab Desk Setup x.y.z.exe` per Windows, `.dmg` per macOS, `.AppImage` per Linux.

Gli installer non sono firmati digitalmente, quindi al primo avvio il sistema mostra un avviso:

- **Windows**: nella finestra "Windows ha protetto il PC" clicca *Ulteriori informazioni* e poi *Esegui comunque*.
- **macOS**: apri l'app con clic destro → *Apri*. Se compare il messaggio "l'app è danneggiata", esegui una volta `xattr -cr "/Applications/GitLab Desk.app"` nel Terminale.
- **Linux**: rendi eseguibile il file (*Proprietà → Permessi*, oppure `chmod +x`) e avvialo con un doppio clic.

## Pubblicare una nuova versione

Gli installer li crea GitHub in automatico, senza usare la riga di comando:

1. Nel repository apri **Releases → Draft a new release**.
2. In *Choose a tag* scrivi il numero di versione preceduto da `v`, ad esempio `v0.1.0`, e scegli *Create new tag on publish*.
3. Dai un titolo, descrivi le novità e clicca **Publish release**.
4. Dopo circa 10 minuti gli installer compaiono in fondo alla release. L'avanzamento si segue nella scheda **Actions**.

Il numero di versione dell'app viene preso dal tag, quindi non serve modificare `package.json`. Per una build di prova senza release: scheda **Actions → Build e release → Run workflow**; gli installer si scaricano dalla pagina dell'esecuzione, nella sezione *Artifacts*.

## Avvio dal codice sorgente (per sviluppare)

```
npm install
npm start
```

Al primo avvio l'app chiede l'indirizzo del server (es. `https://gitlab.azienda.it`) e il token. Il pulsante "Crea un token su GitLab" apre direttamente la pagina giusta con gli scope già selezionati.

## Creare l'installer

```
npm run dist
```

Il pacchetto finisce nella cartella `dist/` (installer NSIS su Windows, DMG su macOS, AppImage su Linux). Su macOS e Windows, senza un certificato di firma, il sistema mostrerà un avviso al primo avvio.

## Test

```
npm test
```

I test controllano il parsing degli URL remoti, il client API (con un server simulato) e le operazioni Git reali su un repository temporaneo.

## Rete aziendale

- Le chiamate alle API GitLab passano dallo stack di rete di Chromium, che usa i certificati e il proxy del sistema operativo: se il browser apre GitLab senza errori, anche l'app ci riesce.
- Git invece usa la propria configurazione. Se clone o push falliscono con un errore di certificato, su Windows di solito basta `git config --global http.sslBackend schannel`; altrimenti chiedi all'IT il certificato della CA aziendale e impostalo con `git config --global http.sslCAInfo percorso/ca.pem`.
- Con l'opzione "Usa il token anche per clone, pull e push via HTTPS" il token viene passato a Git tramite variabili d'ambiente solo verso l'host GitLab configurato: non finisce su disco, nella configurazione di Git né sulla riga di comando. Se preferisci il credential manager di Git o SSH, disattiva l'opzione.

## Sicurezza

Il token è cifrato con il portachiavi del sistema (DPAPI su Windows, Portachiavi su macOS, libsecret su Linux). L'interfaccia gira con `contextIsolation` e sandbox attivi e non ha accesso diretto a Node.js: può chiamare solo le funzioni elencate in `preload.js`.

## Struttura

```
main.js            processo principale: finestra, menu, canali IPC
preload.js         ponte sicuro tra interfaccia e processo principale
src/git.js         operazioni Git (status, diff, commit, branch, rete)
src/gitlab.js      client API GitLab v4 e lettura dell'URL remoto
src/settings.js    impostazioni e token cifrato
renderer/          interfaccia (HTML, CSS, JavaScript senza framework)
test/              test eseguibili con Node
```

## Idee per le prossime versioni

Commenti e approvazione delle merge request dall'app, log dei job della pipeline, stash, strumento per risolvere i conflitti, rebase interattivo, notifiche quando una pipeline finisce, supporto a più server GitLab.

## Licenza

Distribuito con licenza MIT: vedi il file [LICENSE](LICENSE).
