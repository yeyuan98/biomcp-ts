import { describe, it, expect } from '@jest/globals';
import { decodeHtmlEntities, stripHtml } from '../../entities/html-utils.js';

describe('decodeHtmlEntities', () => {
  it('decodes the named entity set', () => {
    expect(decodeHtmlEntities('a&amp;b&lt;c&gt;d&quot;e&#39;f&hellip;g')).toBe("a&b<c>d\"e'f…g");
    expect(decodeHtmlEntities('&nbsp;&mdash;&ndash;')).toBe(' —–');
    expect(decodeHtmlEntities('&le;5 &ge;95% &minus;1')).toBe('≤5 ≥95% −1');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('&#65;&#66;')).toBe('AB');
    expect(decodeHtmlEntities('&#x41;&#X42;')).toBe('AB');
  });

  it('matches entity names case-insensitively', () => {
    expect(decodeHtmlEntities('&AMP;&LT;')).toBe('&<');
  });

  it('leaves unknown entities literal', () => {
    expect(decodeHtmlEntities('&alpha;-D-glucose')).toBe('&alpha;-D-glucose');
  });

  it('never re-decodes its own output (double-encode safety)', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeHtmlEntities('&amp;#38;')).toBe('&#38;');
  });

  it('drops invalid and surrogate codepoints instead of emitting garbage', () => {
    expect(decodeHtmlEntities('&#0;&#x110000;&#xD800;')).toBe('');
    expect(decodeHtmlEntities('a&#xD800;b')).toBe('ab');
  });
});

describe('stripHtml', () => {
  it('inline mode keeps inline-highlighted words joined', () => {
    expect(stripHtml('Interleukin-<b>2</b> signaling')).toBe('Interleukin-2 signaling');
    expect(stripHtml(' <b>CRISPR</b>-Cas systems &hellip;')).toBe('CRISPR-Cas systems …');
  });

  it('block mode separates block markup and collapses whitespace', () => {
    expect(stripHtml('<div>a</div><div>b</div>', 'block')).toBe('a b');
    expect(stripHtml('<p>a\n\n  b</p>', 'block')).toBe('a b');
  });

  it('removes entity-encoded tags but keeps entity-encoded comparison operators', () => {
    // Tag-shaped (&lt;letter...) is markup and must go …
    expect(stripHtml('&lt;script&gt;alert&lt;/script&gt;')).toBe('alert');
    expect(stripHtml('&lt;b&gt;bold&lt;/b&gt; text', 'block')).toBe('bold text');
    // … while &lt;digit / &lt;space sequences are claim text and must survive.
    expect(stripHtml('weight &lt;500 Da and purity &gt;95%', 'block')).toBe('weight <500 Da and purity >95%');
  });

  it('strips mixed raw and entity-encoded nested markup', () => {
    // Raw outer tag + escaped inner tags: both regex passes are needed.
    expect(stripHtml('<div>&lt;div&gt;inner&lt;/div&gt;</div>', 'block')).toBe('inner');
    // Stripping one tag exposes the text the other pass owns; the leading
    // lone `<` (not followed by a letter) is text, not markup.
    expect(stripHtml('<<b>x</b>y', 'block')).toBe('< x y');
  });

  it('leaves non-letter markup as literal text', () => {
    expect(stripHtml('a<!-- comment -->b')).toBe('a<!-- comment -->b');
    expect(stripHtml('x<>y', 'block')).toBe('x<>y');
  });

  it('decodes entities once after stripping (double-encode safety)', () => {
    expect(stripHtml('&amp;lt;b&amp;gt;not a tag&amp;lt;/b&amp;gt;')).toBe('&lt;b&gt;not a tag&lt;/b&gt;');
  });
});
