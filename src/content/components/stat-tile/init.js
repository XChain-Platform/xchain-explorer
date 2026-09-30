(function(){
    'use strict';

    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    REG.register('stat-tile', {
        props: {
            label: { type: "string", required: true },
            value: { type: "string", required: true },
            hint: { type: "string" },
            icon: { type: "string" }
        },
        mount: function(el, props){
            if(!el) throw new Error('no mount point');
            while(el.firstChild) el.removeChild(el.firstChild);
            el.classList.add('xc-stat-tile');
            if(props.icon){
                var icon = el.ownerDocument.createElement('i');
                icon.className = 'xc-stat-tile-icon fa ' + props.icon;
                icon.setAttribute('aria-hidden', 'true');
                el.appendChild(icon);
            }
            var body = el.ownerDocument.createElement('div');
            body.className = 'xc-stat-tile-body';
            var label = el.ownerDocument.createElement('div');
            label.className = 'xc-stat-tile-label text-muted';
            label.textContent = props.label;
            var value = el.ownerDocument.createElement('div');
            value.className = 'xc-stat-tile-value fw-bold';
            value.textContent = props.value;
            body.appendChild(label);
            body.appendChild(value);
            if(props.hint){
                var hint = el.ownerDocument.createElement('div');
                hint.className = 'xc-stat-tile-hint text-muted small';
                hint.textContent = props.hint;
                body.appendChild(hint);
            }
            el.appendChild(body);
            return { label: props.label, value: props.value };
        }
    });
})();
