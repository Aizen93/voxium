import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, queryAllByRole, queryByRole, getByRole, accessibleName, type Mounted } from './dom';

/**
 * The name helper the component suites query by. It must read a control the way assistive
 * technology does, or a suite passes on a control that has no real name.
 */

let view: Mounted;
beforeEach(() => { view = mount(); });
afterEach(() => view.unmount());

describe('accessibleName', () => {
  it('prefers aria-labelledby, then aria-label, then a label for the id, then a wrapping label, then title, then placeholder', async () => {
    await view.render(
      <div>
        <span id="by">From labelledby</span>
        <input id="a" aria-labelledby="by" aria-label="Aria" title="Title" placeholder="Placeholder" />
        <input id="b" aria-label="Aria" title="Title" placeholder="Placeholder" />
        <label htmlFor="c">For label</label>
        <input id="c" title="Title" placeholder="Placeholder" />
        <label>Wrapping label<input id="d" title="Title" placeholder="Placeholder" /></label>
        <input id="e" title="Title" placeholder="Placeholder" />
        <input id="f" placeholder="Placeholder" />
      </div>,
    );
    const name = (id: string) => accessibleName(document.getElementById(id)!);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(name)).toEqual([
      'From labelledby', 'Aria', 'For label', 'Wrapping label', 'Title', 'Placeholder',
    ]);
  });

  it('does not name a button or a link after the label that wraps it', async () => {
    await view.render(
      <label>
        Wrapping text
        <button type="button">Save</button>
        <a href="#x">Docs</a>
      </label>,
    );
    expect(accessibleName(getByRole('button', 'Save'))).toBe('Save');
    expect(accessibleName(document.querySelector('a')!)).toBe('Docs');
  });

  it('names a form control after its wrapping label, never after its own value', async () => {
    await view.render(<label>Note<textarea defaultValue="typed text" /></label>);
    expect(accessibleName(document.querySelector('textarea')!)).toBe('Note');
  });
});

describe('role queries', () => {
  it('skip elements hidden from assistive technology', async () => {
    await view.render(
      <div>
        <button type="button">Visible</button>
        <button type="button" hidden>Hidden attribute</button>
        <button type="button" aria-hidden="true">Aria hidden</button>
        <div aria-hidden="true"><button type="button">Inside a hidden ancestor</button></div>
      </div>,
    );
    expect(queryAllByRole('button').map((b) => accessibleName(b))).toEqual(['Visible']);
    expect(queryByRole('button', 'Aria hidden')).toBeNull();
    expect(queryByRole('button', 'Inside a hidden ancestor')).toBeNull();
  });
});
