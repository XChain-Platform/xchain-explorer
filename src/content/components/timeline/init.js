(function(){
    'use strict';
    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;
    var timelineItem = (typeof XCTimelineItem !== 'undefined')
        ? XCTimelineItem
        : ((typeof require === 'function') ? require('./item.js') : null);
    if(!timelineItem) return;
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
                var empty = el.ownerDocument.createElement('p'); empty.className = 'xc-timeline-empty text-muted mb-0';
                empty.textContent = props.emptyText;
                el.appendChild(empty);
                return { items: 0 };
            }
            var list = el.ownerDocument.createElement('ol');
            list.className = 'xc-timeline-list list-unstyled mb-0';
            props.items.forEach(function(item){ list.appendChild(timelineItem(el.ownerDocument, item)); });
            el.appendChild(list);
            return { items: props.items.length };
        }
    });
})();
