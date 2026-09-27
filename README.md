# AnderStore Installer

Программа для Windows, которая устанавливает **AnderStore** на iPhone. Проект [ANDRESOT](https://andresot.ru).

- Скачать: **https://store.andresot.uk/download**
- Инструкция и помощь: **https://store.andresot.uk/help**
- Приложение AnderStore: https://github.com/ANDRESOTRU/AnderStore

## Как это работает

Мастер из пяти шагов проводит пользователя по установке:

1. **Компьютер** — проверка драйверов Apple (iTunes).
2. **iPhone** — подключение кабелем и доверие компьютеру.
3. **Apple ID** — вход для бесплатной подписи приложения.
4. **Установка** — загрузка и установка AnderStore.
5. **Готово** — памятка настройки iPhone с Apple ID этой установки и кнопкой копирования.

Сервер входа (anisette) по умолчанию: `https://anisette.andresot.uk`.

## Обновление программы ПК

В версии 2.3.9 исправлено окно выбора сертификата: оно доступно во время установки, даже когда шаг Apple ID закрыт. Отзыв выполняется только после выбора одного сертификата и явного подтверждения; приложения, подписанные им, может потребоваться установить заново. Ошибка Apple 429 и ошибка связи с anisette имеют отдельные объяснения. При 429 программа не предлагает немедленно повторять вход или менять пароль и не обещает неизвестный срок ожидания.

При запуске установщик проверяет обновления в фоне. Если есть новая версия, появляется карточка с кнопками «Обновить программу» и «Позже». Скачать и установить обновление можно прямо из окна программы; во время операций с iPhone или Apple ID обновление блокируется. Продление подписи на телефоне — отдельное действие, оно не обновляет установщик ПК.

В мастере и финальной памятке показан Apple ID, которым подписывается AnderStore. Используйте этот же Apple ID в AnderStore на iPhone; менять iCloud не требуется. Памятки для каждого iPhone сохраняются локально в preferences.json без паролей и доступны после перезапуска.

## Сборка

Сборка Windows запускается вручную: **Actions → Build AnderStore Installer (Windows) → Run workflow**.
Результат публикуется в версионный Release `vX.Y.Z`. Версии в `package.json`, `tauri.conf.json`, `Cargo.toml` и `Cargo.lock` должны совпадать; проверка: `node scripts/check-version.mjs`. Перед новым выпуском увеличьте версию во всех четырёх файлах.

Локально:

```
bun i
bun tauri build --bundles nsis
```

Нужны Rust, Bun (или Node.js) и Visual Studio Build Tools с компонентом C++.

## Подписанный выпуск и проверка

GitHub Actions сначала создаёт черновой релиз с EXE, подписью и latest.json. После загрузки файлов обратно проверяются версия, платформа Windows x64, URL установщика, соответствие подписи манифесту и криптографическая подпись EXE. Только затем релиз публикуется и становится последним. Ошибка оставляет предыдущий опубликованный релиз доступным клиентам.

Нужны секреты репозитория TAURI_SIGNING_PRIVATE_KEY и, если ключ защищён паролем, TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Приватный ключ должен соответствовать публичному ключу в конфигурации. С версии 2.3.7 используется собственный ключ AnderStore; он сохранён в GitHub Secrets и имеет локальную резервную копию вне репозитория. При следующих выпусках этот ключ нужно сохранять. Выпуск без подписи не публикуется.

**Переход с 2.3.6 и более старых версий:** один раз скачайте новый установщик и установите вручную. В старых версиях использовался публичный ключ автора iloader; его приватная часть недоступна AnderStore. Поэтому старые версии не могут принять обновление, подписанное новым ключом. После ручного перехода обновления доступны из окна программы.

**Migration from 2.3.6 and earlier:** download and install the new Windows installer once. AnderStore has used its own signing key since 2.3.7. Earlier versions trust the upstream iloader key and cannot verify our releases. After this one-time installation, use the in-app updater.

Проверки:

```
node --test tests/run.mjs
node scripts/check-version.mjs
bun run build
cd src-tauri
cargo check --locked
cargo test --locked
```

Для проверки реального обновления: установить предыдущую версию с ключом AnderStore на тестовой Windows, выпустить новую подписанную версию, запустить проверку из программы, нажать «Обновить программу» и убедиться, что после перезапуска отображается новая версия, а сохранённые памятки доступны. Подмена API в тестах не заменяет этот сценарий.

Автоматизированный сценарий: **Actions → Verify real Windows self-update → Run workflow**. Он устанавливает выпущенную 2.3.7 под отдельным обычным пользователем на одноразовой Windows-машине, нажимает кнопку обновления в настоящем WebView и проверяет версию после автоматического перезапуска и две сохранённые памятки. Установка, проверка подписи и перезапуск используют настоящий Tauri Updater. Артефакт `windows-self-update-evidence` содержит снимки экранов, журналы и `result.json`; полный сценарий подтверждён только при успешном завершении задания.

**Real Windows verification:** run **Verify real Windows self-update** in Actions after publishing a signed version. This exercises the released 2.3.7 installer, the actual in-app update button, native signature validation, NSIS installation, automatic restart and two saved device guides under a disposable standard Windows account. Inspect the `windows-self-update-evidence` artifact; mocked API tests alone do not confirm self-update.

**Статус проверки 2.3.8:** сборка, 18 тестов интерфейса/публикации и 9 Rust-тестов пройдены. Выпуск подписан и опубликован, а установленный EXE на пользовательском ПК имеет версию 2.3.8. На облачной Windows подтверждены настоящая кнопка обновления, загрузка, проверка подписи и установка 2.3.7 → 2.3.8. Полный сценарий с автоматическим перезапуском и сохранением памяток ещё не подтверждён: административный стенд не показал перезапуск, а WebView не запустился под отдельным обычным пользователем. До успешного полного сценария встроенное обновление нельзя считать окончательно проверенным.

**2.3.8 verification status:** signed publication, frontend build, 18 frontend/release tests and 9 Rust tests passed. The real Windows updater downloaded, verified and installed 2.3.8 over 2.3.7. Automatic restart and guide preservation across that restart remain unverified because of hosted Windows desktop/WebView limitations; a successful full smoke run is still required.

## Лицензия

Код распространяется по лицензии **MIT** — см. файл [LICENSE](LICENSE).

AnderStore Installer основан на открытом проекте [iloader](https://github.com/nab138/iloader)
(© nab138, MIT). Авторские права оригинального автора сохранены, как того требует лицензия.
Название и логотип AnderStore принадлежат ANDRESOT; брендинг iloader не используется.
