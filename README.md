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
5. **Готово** — что осталось включить на iPhone.

Сервер входа (anisette) по умолчанию: `https://anisette.andresot.uk`.

## Сборка

Сборка Windows запускается вручную: **Actions → Build AnderStore Installer (Windows) → Run workflow**.
Результат публикуется в Release `installer`.

Локально:

```
bun i
bun tauri build --bundles nsis
```

Нужны Rust, Bun (или Node.js) и Visual Studio Build Tools с компонентом C++.

## Лицензия

Код распространяется по лицензии **MIT** — см. файл [LICENSE](LICENSE).

AnderStore Installer основан на открытом проекте [iloader](https://github.com/nab138/iloader)
(© nab138, MIT). Авторские права оригинального автора сохранены, как того требует лицензия.
Название и логотип AnderStore принадлежат ANDRESOT; брендинг iloader не используется.
