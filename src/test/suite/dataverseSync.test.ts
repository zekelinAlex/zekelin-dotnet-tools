import * as assert from 'assert';
import { mergeDataverseEnvironments } from '../../commands';

suite('mergeDataverseEnvironments', () => {
  test('drops missing, adds new, refreshes matched entries', () => {
    const cached = [
      { name: 'Old name', id: 'AAA', url: '' },
      { name: 'Gone', id: 'bbb', url: 'https://gone.crm4.dynamics.com/' },
      { name: 'ByUrl', id: '', url: 'https://byurl.crm4.dynamics.com/' }
    ];
    const remote = [
      { displayName: 'Zeta', environmentId: 'zzz', environmentUrl: 'https://zeta.crm4.dynamics.com/' },
      { displayName: 'ByUrl', environmentId: 'ccc', environmentUrl: 'https://BYURL.crm4.dynamics.com' },
      { displayName: 'New name', environmentId: 'aaa', environmentUrl: 'https://a.crm4.dynamics.com/' },
      { displayName: 'Alpha', environmentId: 'ddd', environmentUrl: 'https://alpha.crm4.dynamics.com/' }
    ];

    const result = mergeDataverseEnvironments(cached, remote);

    assert.deepStrictEqual(result.environments.map((e) => e.name), ['New name', 'ByUrl', 'Alpha', 'Zeta']);
    assert.deepStrictEqual(result.removed.map((e) => e.name), ['Gone']);
    assert.deepStrictEqual(result.added.map((e) => e.name), ['Alpha', 'Zeta']);
    assert.strictEqual(result.updated.length, 2);
    assert.strictEqual(result.environments[1].id, 'ccc');
  });

  test('ignores remote entries without id or url', () => {
    const result = mergeDataverseEnvironments([], [{ displayName: 'Broken' }, null]);
    assert.strictEqual(result.environments.length, 0);
  });
});
