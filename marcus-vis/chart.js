/* Marcus: daily cloud-cover difference. Shared by the article and standalone preview. */
(() => {
  const script = document.currentScript;
  const source = new URL('../rishika-vis/coastal_cloud_june2025.json', script.src);
  const svg = d3.select('#marcus-chart');
  const slider = document.querySelector('#marcus-hour');
  const SF = 'San Francisco', SD = 'San Diego';
  const label = h => h === 12 ? 'Noon' : `${h} AM`;
  const x = d3.scaleLinear().domain([-100, 100]).range([90, 810]);
  const y = day => 100 + (day - 1) * 23;
  const detail = document.querySelector('#marcus-detail');
  const tooltip = document.createElement('div');
  tooltip.className = 'marcus-tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);
  let selected = null;
  let current = [];
  fetch(source).then(r => { if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); }).then(rows => {
    const dates = [...new Set(rows.map(d => d.date))].sort();
    const lookup = new Map(rows.map(d => [`${d.city}|${d.date}|${d.hour}`, d.pct]));
    for (const city of [SF, SD]) for (const date of dates) for (let hour = 13; hour <= 19; hour++) {
      const pct = lookup.get(`${city}|${date}|${hour}`);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw Error('Missing or invalid daytime observation');
    }
    if (dates.length !== 30) throw Error('Expected 30 June dates');
    svg.append('text').attr('x', 90).attr('y', 22).attr('font-size', 13).text('Cloud-cover difference · SD − SF (percentage points)');
    svg.append('text').attr('x', 90).attr('y', 44).attr('font-size', 13).attr('fill','#2a78d6').text('← San Francisco cloudier');
    svg.append('text').attr('x', 810).attr('y', 44).attr('text-anchor','end').attr('font-size', 13).attr('fill','#eb6834').text('San Diego cloudier →');
    svg.append('g').attr('transform', 'translate(0,67)').call(d3.axisTop(x).tickValues([-100,-50,0,50,100]).tickFormat(d => d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`)).call(g => g.select('.domain').remove());
    svg.append('g').selectAll('line').data([-100,-50,0,50,100]).join('line').attr('x1', x).attr('x2', x).attr('y1', 80).attr('y2', 780).attr('stroke', d => d === 0 ? '#65717a' : '#e7e5de').attr('stroke-width', d => d === 0 ? 1.5 : 1);
    const groups = svg.append('g').selectAll('g').data(dates).join('g').attr('tabindex',0).attr('role','button')
      .attr('transform', (_,i) => `translate(0,${y(i+1)})`).style('cursor','pointer');
    groups.append('rect').attr('class','row-bg').attr('x',25).attr('y',-11).attr('width',810).attr('height',22).attr('rx',4).attr('fill','transparent');
    groups.append('text').attr('x',72).attr('dy','.35em').attr('text-anchor','end').attr('font-size',12).text(d => `Jun ${Number(d.slice(-2))}`);
    groups.append('rect').attr('class','difference').attr('y',-7).attr('height',14).attr('rx',2);
    groups.append('circle').attr('class','tie').attr('r',3).attr('cx',x(0)).attr('fill','#65717a');

    function showTooltip(event, date) {
      inspect(date);
      tooltip.textContent = description(current.find(d => d.date === date));
      tooltip.hidden = false;
      const bounds = event.currentTarget.getBoundingClientRect();
      const px = Number.isFinite(event.clientX) ? event.clientX : bounds.left + bounds.width / 2;
      const py = Number.isFinite(event.clientY) ? event.clientY : bounds.top;
      const box = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(12, Math.min(px + 16, window.innerWidth - box.width - 12))}px`;
      tooltip.style.top = `${Math.max(12, Math.min(py + 16, window.innerHeight - box.height - 12))}px`;
    }
    const hideTooltip = () => { tooltip.hidden = true; };
    window.addEventListener('scroll', hideTooltip, { passive: true });
    window.addEventListener('resize', hideTooltip);
    function inspect(date) {
      selected = date;
      groups.select('.row-bg').attr('fill', d => d === selected ? '#edf1f5' : 'transparent');
      const d = current.find(d => d.date === date);
      detail.textContent = description(d);
    }
    function description(d) {
      const diff = Math.abs(d.sf-d.sd);
      return `June ${Number(d.date.slice(-2))}, ${label(+slider.value)} PDT: SF ${d.sf.toFixed(1)}%; SD ${d.sd.toFixed(1)}%. ` +
        (diff === 0 ? 'Equal cloud cover.' : `${d.sf > d.sd ? SF : SD} is cloudier by ${diff.toFixed(1)} percentage points.`);
    }
    groups.on('mouseenter', showTooltip).on('mousemove', showTooltip).on('focus', showTooltip).on('click', showTooltip)
      .on('mouseleave', hideTooltip).on('blur', hideTooltip)
      .on('keydown',(event,d) => {
        if (event.key === 'Escape') hideTooltip();
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTooltip(event,d); }
      });
    function update() {
      const utc = +slider.value + 7;
      current = dates.map(date => ({date,sf:lookup.get(`${SF}|${date}|${utc}`),sd:lookup.get(`${SD}|${date}|${utc}`)}));
      const byDate = new Map(current.map(d => [d.date,d]));
      const sf = current.filter(d => d.sf > d.sd).length, sd = current.filter(d => d.sd > d.sf).length;
      document.querySelector('#marcus-hour-label').textContent = label(+slider.value);
      slider.setAttribute('aria-valuetext', `${label(+slider.value)} PDT`);
      document.querySelector('#marcus-summary').textContent = `${label(+slider.value)}: SF is cloudier on ${sf} days; SD on ${sd}; ${30-sf-sd} tied, out of 30 June days.`;
      svg.attr('aria-label', `Daily SD minus SF cloud-cover difference at ${label(+slider.value)} PDT`);
      groups.select('.difference')
        .attr('x', d => x(Math.min(0, byDate.get(d).sd - byDate.get(d).sf)))
        .attr('width', d => Math.abs(x(byDate.get(d).sd - byDate.get(d).sf) - x(0)))
        .attr('fill', d => byDate.get(d).sf > byDate.get(d).sd ? '#2a78d6' : '#eb6834');
      groups.select('.tie').attr('visibility',d => byDate.get(d).sf === byDate.get(d).sd ? 'visible' : 'hidden');
      groups.attr('aria-label',d => description(byDate.get(d)));
      if (selected) {
        inspect(selected);
        if (!tooltip.hidden) tooltip.textContent = description(byDate.get(selected));
      }
    }
    const play = document.querySelector('#marcus-play');
    let timer = null;
    function pause() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Play morning comparison');
      play.setAttribute('aria-pressed', 'false');
    }
    play.disabled = false;
    play.addEventListener('click', () => {
      if (timer !== null) { pause(); return; }
      if (+slider.value >= 12) { slider.value = 6; update(); }
      play.textContent = '❚❚';
      play.setAttribute('aria-label', 'Pause morning comparison');
      play.setAttribute('aria-pressed', 'true');
      timer = window.setInterval(() => {
        slider.value = Math.min(12, +slider.value + 1);
        update();
        if (+slider.value === 12) pause();
      }, 1000);
    });
    slider.addEventListener('input', () => { pause(); update(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    update();
  }).catch(e => { document.querySelector('#marcus-error').textContent = `Could not load daily chart: ${e.message}. Open the project with Live Server.`; });
})();
