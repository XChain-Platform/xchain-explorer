(function(){
    'use strict';

    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    REG.register('badge-list', {
        props: {
            items: { type: "array", required: true },
            emptyText: { type: "string", default: "None" }
        },
        mount: function(el, props){
            if(!el) throw new Error('no mount point');
            while(el.firstChild) el.removeChild(el.firstChild);
            el.classList.add('xc-badge-list');
            if(!props.items.length){
                el.classList.add('text-muted');
                el.textContent = props.emptyText;
                return { items: 0 };
            }
            props.items.forEach(function(item){
                var data = (item && typeof item === 'object') ? item : { label: item };
                var state = String(data.state || 'default').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
                var badge = el.ownerDocument.createElement('span');
                badge.className = 'xc-badge xc-badge-' + state;
                badge.setAttribute('data-state', state);
                badge.textContent = data.label == null ? '' : String(data.label);
                el.appendChild(badge);
            });
            return { items: props.items.length };
        }
    });
})();
