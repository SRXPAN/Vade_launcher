import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type { AppLanguage } from '@vade/protocol';
import { en } from './en';
import { pl } from './pl';
import { uk, type I18nKey } from './uk';

export type { I18nKey };

export const DICTIONARIES: Record<AppLanguage, Record<I18nKey, string>> = {
  uk,
  pl,
  en,
};

export const LOCALE_BY_LANG: Record<AppLanguage, string> = {
  uk: 'uk-UA',
  pl: 'pl-PL',
  en: 'en-US',
};

export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  uk: 'Українська',
  pl: 'Polski',
  en: 'English',
};

export function translate(lang: AppLanguage, key: I18nKey, params?: Record<string, string | number>): string {
  const dict = DICTIONARIES[lang] ?? uk;
  let text = dict[key] ?? uk[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export interface I18nContextValue {
  lang: AppLanguage;
  locale: string;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'uk',
  locale: 'uk-UA',
  t: (key, params) => translate('uk', key, params),
});

export function I18nProvider({ lang, children }: { lang: AppLanguage; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      locale: LOCALE_BY_LANG[lang] ?? 'uk-UA',
      t: (key, params) => translate(lang, key, params),
    }),
    [lang],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
