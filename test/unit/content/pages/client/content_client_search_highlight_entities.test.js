'use strict';

// highlightSearchTerm must show stored text as that same text, even when the
// term equals an entity token ("lt", "quot", "#39") that would otherwise
// match inside escaped text and display "<" as a literal "&lt;".

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '..', '..', '../../../src/content');
const CLIENT_SRC = require('../../../../helpers/content-source.js').clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');

function boot(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'https://xchain.test/RBTC/search'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    return win;
}

function render(win, term, text){
    const td = win.document.createElement('td');
    win.jQuery(td).html(win.highlightSearchTerm(term, text));
    return td;
}

describe('highlightSearchTerm keeps stored text intact', function () {
    const cases = [
        ['lt',   '</script><script>window.__x=1</script>'],
        ['quot', '"><img src=x onerror="window.__x=1">'],
        ['#39',  "{{constructor.constructor('return 1')()}}"],
        ['amp',  'a & b &amp; c'],
        ['gt',   'x > y']
    ];
    cases.forEach(function ([term, text]) {
        it('term ' + JSON.stringify(term) + ' leaves textContent equal to the stored text', function () {
            const win = boot();
            const td = render(win, term, text);
            expect(td.textContent).to.equal(text);
            expect(td.querySelector('img,script')).to.equal(null);
            expect(win.__x).to.equal(undefined);
        });
    });

    it('highlights one span with the original case', function () {
        const td = render(boot(), 'foo', 'a Foo b');
        const spans = td.querySelectorAll('.highlight-search-term');
        expect(spans.length).to.equal(1);
        expect(spans[0].textContent).to.equal('Foo');
        expect(td.textContent).to.equal('a Foo b');
    });

    it('matches an uppercase term case-insensitively', function () {
        const td = render(boot(), 'FOO', 'foo and Foo');
        expect(td.querySelectorAll('.highlight-search-term').length).to.equal(2);
        expect(td.textContent).to.equal('foo and Foo');
    });

    it('highlights a raw "<" term and escapes it', function () {
        const td = render(boot(), '<b', 'x <b> y');
        const spans = td.querySelectorAll('.highlight-search-term');
        expect(spans.length).to.equal(1);
        expect(spans[0].textContent).to.equal('<b');
        expect(td.textContent).to.equal('x <b> y');
        expect(td.querySelector('b')).to.equal(null);
    });

    it('returns escaped text for an empty term', function () {
        const win = boot();
        expect(win.highlightSearchTerm('', 'a<b')).to.equal('a&lt;b');
    });
});
