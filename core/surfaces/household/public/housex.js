(function () {
  'use strict';
  const tones = Object.freeze({
    online:'#71e7bb', busy:'#f0b975', parked:'#b1a2e2', degraded:'#efaf76',
    offline:'#ee918e', unknown:'#718899', stale:'#718899'
  });
  function mount(scene) {
    const layout = JSON.parse(scene.dataset.layout);
    const canvas = scene.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const pins = new Map(Array.from(scene.querySelectorAll('[data-pin]'), node => [node.dataset.pin, node]));
    const corners = [[-1,0,-1],[1,0,-1],[1,0,1],[-1,0,1],[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]];
    const sides = [
      { corners:[4,7,6,5], normal:[0,1,0], light:1.12 },
      { corners:[0,4,5,1], normal:[0,0,-1], light:.72 },
      { corners:[1,5,6,2], normal:[1,0,0], light:.84 },
      { corners:[2,6,7,3], normal:[0,0,1], light:.75 },
      { corners:[3,7,4,0], normal:[-1,0,0], light:.91 }
    ];
    const meshes = layout.boxes.map(({ position:[x,y,z], size:[w,h,d], color, layer, statusFor }) => ({
      vertices: corners.map(([u,v,t]) => [x+u*w/2,y+v*h,z+t*d/2]), color, layer, statusFor
    }));
    const extent = Math.max(6, ...meshes.flatMap(mesh => mesh.vertices.map(([x,,z]) => Math.hypot(x,z))));
    const base = { rotation:layout.camera?.rotation ?? -.55, elevation:layout.camera?.elevation ?? .62, x:0, z:0, zoom:1 };
    const view = { ...base };
    let observations = new Map();
    let width, height, animation, plan = false;

    function shade(color, light) {
      const rgb = Number.parseInt(color.slice(1), 16);
      const channel = shift => Math.min(255, Math.round((rgb >> shift & 255) * light));
      return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
    }

    function draw() {
      if (!ctx || !width || !height) return;
      const scale = Math.min((width - 34) / (extent * 2), (height - 74) / (extent * 1.45)) * view.zoom;
      const cos = Math.cos(view.rotation), sin = Math.sin(view.rotation);
      const high = Math.sin(view.elevation), low = Math.cos(view.elevation);
      function project([x,y,z]) {
        const dx = x - view.x, dz = z - view.z;
        const depth = dx * sin + dz * cos;
        return [width/2 + (dx * cos - dz * sin) * scale, height*.57 + (depth * high - y * low) * scale, depth * low + y * high];
      }
      const backdrop = ctx.createRadialGradient(width*.5,height*.49,20,width*.5,height*.49,width*.72);
      backdrop.addColorStop(0,'#193948'); backdrop.addColorStop(1,'#09151e');
      ctx.fillStyle = backdrop; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#40627561'; ctx.lineWidth = .75;
      for (let i = -20; i <= 20; i++) {
        for (const [from, to] of [[[-20,-.55,i],[20,-.55,i]],[[i,-.55,-20],[i,-.55,20]]]) {
          const [x,y] = project(from), [ex,ey] = project(to);
          ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(ex,ey); ctx.stroke();
        }
      }
      const faces = [];
      for (const mesh of meshes) {
        if (mesh.layer === 3 && cos * low <= .08) continue;
        const points = mesh.vertices.map(project);
        for (const side of sides) {
          const [x,y,z] = side.normal;
          if (x*sin*low + y*high + z*cos*low < .001) continue;
          const polygon = side.corners.map(index => points[index]);
          const color = tones[observations.get(mesh.statusFor)] || mesh.color;
          faces.push({ polygon, depth:polygon.reduce((sum,p)=>sum+p[2],0)/4, layer:mesh.layer, color:shade(color,side.light) });
        }
      }
      if (cos * low > .08) for (const disc of layout.discs || []) {
        const [x,y,z] = disc.position;
        const polygon = Array.from({ length:20 }, (_, index) => {
          const angle = index * Math.PI / 10;
          return project([x+disc.radius*Math.cos(angle), y+disc.radius*Math.sin(angle), z]);
        });
        faces.push({ polygon, depth:project(disc.position)[2], layer:3, color:disc.color });
      }
      faces.sort((a,b) => a.layer-b.layer || a.depth-b.depth);
      let pathsDrawn = false;
      for (const face of faces) {
        // Network routes sit on the base beneath the tower meshes.
        if (face.layer >= 2 && !pathsDrawn) {
          pathsDrawn = true;
          for (const path of layout.paths || []) {
            ctx.beginPath();
            path.points.map(project).forEach(([x,y],index) => index ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
            ctx.strokeStyle = path.color; ctx.lineWidth = 2; ctx.stroke();
          }
        }
        ctx.beginPath();
        face.polygon.forEach(([x,y],index) => index ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
        ctx.closePath(); ctx.fillStyle = face.color; ctx.fill();
        ctx.strokeStyle = '#1429328a'; ctx.lineWidth = .75; ctx.stroke();
      }
      ctx.font = '600 12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#d4e4ec';
      for (const room of layout.rooms) {
        const [x,y] = project(room.position);
        ctx.fillText(room.label, x, y);
      }
      for (const pin of layout.pins) {
        const link = pins.get(pin.id);
        if (!link) continue;
        const [x,y] = project(pin.position);
        link.hidden = false;
        const half = Math.max(25, link.offsetWidth / 2 + 5);
        const anchorX = Math.min(width-half,Math.max(half,x));
        const anchorY = Math.min(height-40,Math.max(69,y-33-(pin.labelLift || 0)));
        const tint = tones[observations.get(pin.id)] || (link.hasAttribute('aria-current') ? '#8ff0d7' : '#94b7cb');
        ctx.strokeStyle = tint; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(anchorX,anchorY+10); ctx.stroke();
        ctx.fillStyle = tint; ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill();
        link.style.left = anchorX + 'px'; link.style.top = anchorY + 'px';
      }
    }

    function move(target) {
      cancelAnimationFrame(animation);
      const origin = { ...view }, start = performance.now();
      function step(now) {
        const t = reduced.matches ? 1 : Math.min(1,(now-start)/420);
        for (const key of Object.keys(target)) view[key] = origin[key] + (target[key]-origin[key]) * (1-(1-t)**3);
        draw();
        if (t < 1) animation = requestAnimationFrame(step);
      }
      animation = requestAnimationFrame(step);
    }

    function resize() {
      const box = scene.getBoundingClientRect();
      if (!ctx || box.width === 0) return;
      width = box.width; height = box.height;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    }

    scene.addEventListener('click', event => {
      const choice = event.target.closest('button');
      if (!choice) return;
      if (choice.dataset.angle) {
        plan = choice.dataset.angle === 'plan';
        scene.querySelectorAll('[data-angle]').forEach(button => button.setAttribute('aria-pressed', String(button === choice)));
        move({ ...base, ...(plan && { elevation:1.567, rotation:0 }) });
      }
      if (choice.hasAttribute('data-rotate')) move({ rotation:view.rotation + (plan ? Math.PI/2 : .45) });
    });
    new ResizeObserver(resize).observe(scene);
    resize();
    function focus(id) {
      const pin = layout.pins.find(row => row.id === id);
      if (!pin) return;
      const [x,,z] = pin.position;
      move({ x:x*.20, z:z*.20, zoom:1.12 });
    }
    focus(scene.dataset.selected);
    return { focus, setObservations(states) { observations = states; draw(); } };
  }

  const scenes = new Map(Array.from(document.querySelectorAll('.housex-scene'), scene => [scene, mount(scene)]));
  window.HouseXScenes = scenes;
  const ecosystem = document.querySelector('[data-infrastructure], [data-ecosystem-frame]');
  if (!ecosystem) return;
  const home = document.querySelector('[data-home]');
  const views = Array.from(document.querySelectorAll('[data-view]'));
  for (const button of views) button.addEventListener('click', () => {
    const showEcosystem = button.dataset.view === 'ecosystem';
    if (showEcosystem && ecosystem.dataset.ecosystemFrame && !ecosystem.hasAttribute('src')) {
      ecosystem.src = ecosystem.dataset.ecosystemFrame;
    }
    home.hidden = showEcosystem; ecosystem.hidden = !showEcosystem;
    views.forEach(viewButton => viewButton.setAttribute('aria-pressed', String(viewButton === button)));
    document.dispatchEvent(new Event('housex-view-changed'));
  });
})();
