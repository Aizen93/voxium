import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APOSTROPHE,
  NBSP,
  KEPT_AS_WRITTEN,
  setFrenchTypography,
  setFrenchApostrophes,
  setFrenchTypographyInJson,
  stringValues,
} from '../../../../../scripts/lib/frenchTypography.mjs';
import { fixFile } from '../../../../../scripts/fix-french-typography.mjs';

// The French typography pass of scripts/fix-french-typography.mjs (beside the
// other root scripts' tests). `A` and `N` stand for U+2019 and U+00A0 so the
// expected strings show them.
const A = APOSTROPHE;
const N = NBSP;

describe('code points', () => {
  it('uses U+2019 and U+00A0, the ones the project French tests use', () => {
    expect(A).toBe('\u2019');
    expect(N).toBe('\u00a0');
  });
});

describe('apostrophe', () => {
  it.each([
    ["l'espace", `l${A}espace`],
    ["aujourd'hui", `aujourd${A}hui`],
    ["qu'il n'est pas d'un autre", `qu${A}il n${A}est pas d${A}un autre`],
    ["l'a'b", `l${A}a${A}b`],
    ["L'URL", `L${A}URL`],
  ])('between two letters: %s', (input, expected) => {
    expect(setFrenchTypography(input)).toBe(expected);
  });

  it.each([
    "quotes around a word, pas une élision 'texte'",
    "{{it's}} stays inside a placeholder",
    '<a title="l\'x">l</a>',
    "`l'x` is a code span",
    "https://exemple.org/l'x est une adresse",
    "un 5'6 sans lettres",
  ])('left alone: %s', (input) => {
    expect(setFrenchTypography(input)).toBe(input);
  });

  it('keeps a value listed as written', () => {
    expect(KEPT_AS_WRITTEN.has('Which events would you like to trigger this webhook?')).toBe(true);
    for (const value of KEPT_AS_WRITTEN.keys()) expect(setFrenchTypography(value)).toBe(value);
  });
});

describe('no-break space before ? ! : ;', () => {
  it.each([
    ['Bon retour !', `Bon retour${N}!`],
    ['Vraiment ?', `Vraiment${N}?`],
    ['Ensuite : voilà', `Ensuite${N}: voilà`],
    ['Un ; deux', `Un${N}; deux`],
    ['Bonjour!', `Bonjour${N}!`],
    ['Vraiment?', `Vraiment${N}?`],
    ['Actuel:', `Actuel${N}:`],
    ['Étape 1: ouvrir', `Étape 1${N}: ouvrir`],
    ['Un;deux ; trois', `Un;deux${N}; trois`],
    ['(contexte non sécurisé ?)', `(contexte non sécurisé${N}?)`],
    ['(contexte?)', `(contexte${N}?)`],
  ])('%s', (input, expected) => {
    expect(setFrenchTypography(input)).toBe(expected);
  });

  it('a pair ?! takes one no-break space before it and none inside', () => {
    expect(setFrenchTypography('Quoi ?!')).toBe(`Quoi${N}?!`);
    expect(setFrenchTypography('Quoi?!')).toBe(`Quoi${N}?!`);
    expect(setFrenchTypography('Quoi !?')).toBe(`Quoi${N}!?`);
  });

  it('a placeholder before a mark is text: the mark is spaced', () => {
    expect(setFrenchTypography('{{name}}: fichier')).toBe(`{{name}}${N}: fichier`);
    expect(setFrenchTypography('{{name}} : fichier')).toBe(`{{name}}${N}: fichier`);
    expect(setFrenchTypography('Supprimer <1>{{name}}</1> ?')).toBe(`Supprimer <1>{{name}}</1>${N}?`);
    expect(setFrenchTypography('{{count}} messages ?')).toBe(`{{count}} messages${N}?`);
  });

  it('several marks in one value', () => {
    expect(setFrenchTypography("Prêt ? Voici : l'essentiel ; allons-y !")).toBe(
      `Prêt${N}? Voici${N}: l${A}essentiel${N}; allons-y${N}!`,
    );
  });

  it.each([
    ['https://voxium.app/a?b=1&c=2 ici', 'a web address'],
    ['Écrire à mailto:aide@voxium.app: merci', 'a mail address with its scheme'],
    ['Voir https://exemple.org/page: la suite', 'an address followed by a colon'],
    ['Rendez-vous à 10:30 ou 16:9', 'a time and a ratio'],
    ['Le port est localhost:3001', 'a host and a port'],
    ['<0>texte</0> et <strong>gras</strong>', 'tags'],
    ['<a href="https://exemple.org:8080/x">lien</a>', 'a tag with attributes'],
    ['Bien reçu :) merci ;)', 'emoticons'],
    ['Vous voilà :smile: enfin', 'an emoji shortcode'],
    ['Appuyez sur Ctrl+; pour ouvrir', 'a keyboard shortcut'],
    ['Appuyez sur Ctrl+Shift+: pour fermer', 'a keyboard shortcut with a colon'],
    ['`a ? b : c` est du code', 'a code span'],
    ['?début de chaîne', 'a mark at the very start'],
    [': début de chaîne', 'a colon at the very start'],
    ['page?id=3 et a!b', 'a mark followed by a word character'],
    ['dossier\\fichier:nom', 'a path'],
    ['deux  : espaces', 'two spaces: left as written'],
  ])('left alone: %s (%s)', (input) => {
    expect(setFrenchTypography(input)).toBe(input);
  });

  it('a no-break space already there stays, once', () => {
    const v = `Déjà${N}? Oui${N}: voilà${N}!`;
    expect(setFrenchTypography(v)).toBe(v);
  });
});

describe('guillemets', () => {
  it.each([
    ['« texte »', `«${N}texte${N}»`],
    ['«texte»', `«${N}texte${N}»`],
    [`«${N}texte${N}»`, `«${N}texte${N}»`],
    ['le choix « {{name}} » est pris', `le choix «${N}{{name}}${N}» est pris`],
    ['Dis « oui » !', `Dis «${N}oui${N}»${N}!`],
  ])('%s', (input, expected) => {
    expect(setFrenchTypography(input)).toBe(expected);
  });
});

describe('elision before a placeholder, a digit, a guillemet or an opening tag', () => {
  it.each([
    ["l'{{name}}", `l${A}{{name}}`],
    ["l'1", `l${A}1`],
    ["qu'«x»", `qu${A}«x»`],
    ["d'<1>espace</1>", `d${A}<1>espace</1>`],
    ["aujourd'hui", `aujourd${A}hui`],
    ["c'est-à-dire", `c${A}est-à-dire`],
    ["D'accord", `D${A}accord`],
    // An English contraction inside a French string is still a letter, an
    // apostrophe and a letter: it takes the typographic apostrophe too.
    ["Dis don't", `Dis don${A}t`],
  ])('sets the apostrophe of %s', (input, expected) => {
    expect(setFrenchApostrophes(input)).toBe(expected);
  });

  it.each([
    "'texte' entre apostrophes",
    "un 'mot'",
    "mesure 5' de large",
    "taille 5'6",
    "`l'{{x}}` est du code",
    "l'</1> ferme une balise",
    "https://exemple.org/l'1 est une adresse",
    "{{l'1}} reste dans le placeholder",
    'Voir https://exemple.org/{{id}}?a=1 puis {{id}}',
    '<a href="{{url}}">lien</a>',
  ])('leaves the apostrophe of %s', (input) => {
    expect(setFrenchApostrophes(input)).toBe(input.replace(/n'est/, `n${A}est`));
  });

  it('works together with the spacing rules', () => {
    expect(setFrenchTypography("qu'«x»")).toBe(`qu${A}«${N}x${N}»`);
  });
});

describe('more spacing cases', () => {
  const NARROW = String.fromCharCode(0x202f);
  it.each([
    ['{{count}} :', `{{count}}${N}:`],
    ['Sûr?)', `Sûr${N}?)`],
    ['Sûr ?)', `Sûr${N}?)`],
    ['«Super!»', `«${N}Super${N}!${N}»`],
    ['Alors...?', `Alors...${N}?`],
    ['Alors ...?', `Alors ...${N}?`],
    ['Liste:\nsuite', `Liste${N}:\nsuite`],
    ['?', '?'],
    ['!', '!'],
    [`Quoi${NARROW}?`, `Quoi${N}?`],
    [`«${NARROW}x${NARROW}»`, `«${N}x${N}»`],
  ])('%j', (input, expected) => {
    expect(setFrenchTypography(input)).toBe(expected);
  });
});

describe('idempotence', () => {
  it.each([
    "Prêt ? Voici : l'essentiel ; allons-y ! « oui »",
    'Quoi?! {{name}}: <1>x</1> 10:30 https://a.b/c?d=e',
    "l'a'b :) Ctrl+; `a ? b`",
  ])('a second pass changes nothing: %s', (input) => {
    const once = setFrenchTypography(input);
    expect(setFrenchTypography(once)).toBe(once);
  });
});

describe('the locale text', () => {
  const file = (lines: string[], eol = '\r\n', last = true) => lines.join(eol) + (last ? eol : '');

  it('keeps CRLF, the indent, the key order, the final newline and every escape', () => {
    const before = file([
      '{',
      '  "zeta": "Vous n\'avez pas ?",',
      '  "alpha": {',
      '    "b": "Dis \\"oui\\" \\u00e9 !",',
      '    "a": "ok"',
      '  }',
      '}',
    ]);
    const after = setFrenchTypographyInJson(before);
    expect(after).toBe(
      file([
        '{',
        `  "zeta": "Vous n${A}avez pas${N}?",`,
        '  "alpha": {',
        `    "b": "Dis \\"oui\\" \\u00e9${N}!",`,
        '    "a": "ok"',
        '  }',
        '}',
      ]),
    );
  });

  it('keeps LF files LF and a file with no final newline', () => {
    const before = file(['{', '  "a": "Salut !"', '}'], '\n', false);
    expect(setFrenchTypographyInJson(before)).toBe(`{\n  "a": "Salut${N}!"\n}`);
  });

  it('never touches a key', () => {
    const before = file(['{', '  "n\'a ? b": "x",', '  "k": "c\'est ?"', '}']);
    const lines = setFrenchTypographyInJson(before).split('\r\n');
    expect(lines[1]).toBe('  "n\'a ? b": "x",');
    expect(lines[2]).toBe(`  "k": "c${A}est${N}?"`);
  });

  it('handles a bare string line of an array', () => {
    expect(setFrenchTypographyInJson('[\r\n  "l\'un ?",\r\n  "x"\r\n]\r\n')).toBe(
      `[\r\n  "l${A}un${N}?",\r\n  "x"\r\n]\r\n`,
    );
  });

  it('a file whose values need nothing is returned as it is', () => {
    const text = file(['{', `  "a": "Déjà${N}? l${A}essentiel",`, '  "b": "ok"', '}']);
    expect(setFrenchTypographyInJson(text)).toBe(text);
  });

  it('stringValues walks nested bundles with dotted keys', () => {
    expect(stringValues({ a: { b: 'x', c: { d: 'y' } }, e: 'z', n: 1 })).toEqual([
      ['a.b', 'x'],
      ['a.c.d', 'y'],
      ['e', 'z'],
    ]);
  });
});

describe('a backslash and n after a mark', () => {
  it.each(['C:\\nom', 'Fichier C:\\nom', 'D:\\tmp et E:\\rien'])(
    'a parsed value is not a line break: %s',
    (input) => {
      expect(setFrenchTypography(input)).toBe(input);
    },
  );

  it('a REAL line break after a mark is whitespace on a parsed value', () => {
    expect(setFrenchTypography('Liste:\nsuite')).toBe(`Liste${N}:\nsuite`);
  });

  it('the raw-JSON pass reads the two-character escape as a line break', () => {
    const raw = ['{', '  "a": "Liste:\\nsuite",', '  "b": "Liste :\\nsuite",', '  "c": "C:\\nom"', '}'].join('\n');
    const lines = setFrenchTypographyInJson(raw).split('\n');
    expect(lines[1]).toBe(`  "a": "Liste${N}:\\nsuite",`);
    expect(lines[2]).toBe(`  "b": "Liste${N}:\\nsuite",`);
    // On raw text the path's colon is followed by a break too: the pass cannot tell.
    expect(setFrenchTypography('Liste:\\nsuite', { jsonEscapes: true })).toBe(`Liste${N}:\\nsuite`);
    expect(setFrenchTypography('Liste:\\nsuite')).toBe('Liste:\\nsuite');
  });
});

describe('a value holding the pass\'s own private-use characters', () => {
  const PRIVATE = String.fromCharCode(0xe000);

  it('is refused, saying why', () => {
    expect(() => setFrenchTypography(`Z${PRIVATE} :`)).toThrow(/private-use/);
    expect(() => setFrenchApostrophes(`Z${String.fromCharCode(0xe1ff)}`)).toThrow(/U\+E000 to U\+E1FF/);
  });

  it('names the entry when it comes from the file text', () => {
    const raw = `{\r\n  "some.key": "a${PRIVATE}b"\r\n}\r\n`;
    expect(() => setFrenchTypographyInJson(raw)).toThrow(/"some\.key"/);
  });

  it('leaves the file untouched and exits non-zero from the command line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fr-typo-'));
    try {
      const target = path.join(dir, 'fr.json');
      const text = `{\r\n  "k": "a${PRIVATE}b ?",\r\n  "j": "l'x ?"\r\n}\r\n`;
      writeFileSync(target, text, 'utf8');
      expect(() => fixFile(target)).toThrow(/private-use/);
      expect(readFileSync(target, 'utf8')).toBe(text);
      const cli = path.resolve(__dirname, '../../../../../scripts/fix-french-typography.mjs');
      const run = spawnSync(process.execPath, [cli, target], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/private-use/);
      expect(readFileSync(target, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the script', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('rewrites the file once and then reports nothing to change', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fr-typo-'));
    const target = path.join(dir, 'fr.json');
    writeFileSync(target, '{\r\n  "a": "Qu\'est-ce que c\'est ?"\r\n}\r\n', 'utf8');
    expect(fixFile(target)).toBe(true);
    const once = readFileSync(target, 'utf8');
    expect(once).toBe(`{\r\n  "a": "Qu${A}est-ce que c${A}est${N}?"\r\n}\r\n`);
    expect(fixFile(target)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(once);
  });
});
