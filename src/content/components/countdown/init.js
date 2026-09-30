(function(){
    'use strict';

    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    REG.register('countdown', {
        props: {
            target: { type: "number", required: true },
            current: { type: "number", required: true },
            unit: { type: "string", default: "blocks" },
            completeText: { type: "string", default: "Ready" }
        },
        mount: function(el, props){
            if(!el) throw new Error('no mount point');
            var remaining = Math.max(0, props.target - props.current);
            var complete = remaining === 0;
            el.classList.add('xc-countdown');
            el.classList.toggle('xc-countdown-complete', complete);
            el.setAttribute('data-countdown-state', complete ? 'complete' : 'pending');
            el.setAttribute('data-target', String(props.target));
            el.textContent = complete ? props.completeText : remaining + ' ' + props.unit;
            return { remaining: remaining, complete: complete };
        }
    });
})();
