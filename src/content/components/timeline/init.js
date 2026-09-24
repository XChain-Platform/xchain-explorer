(function(){
    'use strict';

    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    REG.register('timeline', {
        props: {
            items: { type: "array", required: true },
            emptyText: { type: "string", default: "No timeline events." }
        },
        mount: function(el, props){
            if(!el) throw new Error('no mount point');
            while(el.firstChild) el.removeChild(el.firstChild);
            el.classList.add('xc-timeline');
            if(!props.items.length){
                var empty = el.ownerDocument.createElement('p');
                empty.className = 'xc-timeline-empty text-muted mb-0';
                empty.textContent = props.emptyText;
                el.appendChild(empty);
                return { items: 0 };
            }
            var list = el.ownerDocument.createElement('ol');
            list.className = 'xc-timeline-list list-unstyled mb-0';
            props.items.forEach(function(item){
                item = item || {};
                var row = el.ownerDocument.createElement('li');
                var state = String(item.state || 'pending').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
                row.className = 'xc-timeline-item xc-timeline-' + state;
                row.setAttribute('data-state', state);
                var marker = el.ownerDocument.createElement('span');
                marker.className = 'xc-timeline-marker';
                marker.setAttribute('aria-hidden', 'true');
                var body = el.ownerDocument.createElement('div');
                body.className = 'xc-timeline-body';
                var label = el.ownerDocument.createElement('div');
                label.className = 'xc-timeline-label fw-semibold';
                label.textContent = item.label == null ? '' : String(item.label);
                body.appendChild(label);
                if(item.detail != null){
                    var detail = el.ownerDocument.createElement('div');
                    detail.className = 'xc-timeline-detail';
                    detail.textContent = String(item.detail);
                    body.appendChild(detail);
                }
                if(item.meta != null){
                    var meta = el.ownerDocument.createElement('div');
                    meta.className = 'xc-timeline-meta text-muted small';
                    meta.textContent = String(item.meta);
                    body.appendChild(meta);
                }
                row.appendChild(marker);
                row.appendChild(body);
                list.appendChild(row);
            });
            el.appendChild(list);
            return { items: props.items.length };
        }
    });
})();
