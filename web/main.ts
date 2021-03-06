import $ from "jquery";
import "datatables.net";
import DataTablesScroller from "datatables.net-scroller";
import Chart from "chart.js";

DataTablesScroller();

function assert(x: null|undefined): never;
function assert(x: object): void;
function assert(x: any): void {
  if (x == null)
    throw new Error("assertion failure");
}

type Dict<T> = { [name: string]: T };

type Field = {
  name: string,
  type: string,
  title: string,
  descr: null|string,
  units: null|string,
  top: boolean,
  disp: boolean,
  base: string,
  terms: boolean
};

type Catalog = {
  uri: string,
  bulk: string[],
  fields: Field[],
  count?: number,
};

type Query = undefined|string|number|{lb:string|number, ub:string|number};

var TCat: DataTables.Api;
declare const Catalog: Catalog;
declare const Query: {offset:number, limit:number, sort:{field:string,asc:boolean}[], fields:string[], filter:{field:string,value:Query}, aggs:string[], hist:string|null};
const Fields_idx: Dict<number> = {};
const Filters: Array<Filter> = [];
var Sample: number = 1;
var Seed: undefined|number = 0;
var Update_aggs: number = 0;
var Histogram: undefined|NumericFilter;
const Histogram_bins = 100;
var Histogram_chart: Chart|undefined;
var Histogram_bin_width = 0;

var Download_query: Dict<string> = {};
function set_download(query: Dict<string> = Download_query) {
  delete query.limit;
  delete query.offset;
  delete query.aggs;
  delete query.hist;
  query.fields = TCat.columns(':visible').dataSrc().join(' ');
  const q = '?' + $.param(Download_query = query);
  const h = $('#download').html('download as ');
  for (let f of Catalog.bulk) {
    const a = document.createElement('a');
    h.append(a);
    a.id = 'download.' + f;
    a.href = Catalog.uri + '/' + f + q;
    a.appendChild(document.createTextNode(f));
    h.append(document.createTextNode(' '));
  }
}

var Histogram_drag_start: number|null = null;

function getChartX(point: any) {
  /* needs internal chart.js access? */
  return point._xScale.getLabelForIndex(point._index, point._datasetIndex);
}

function histogram(agg: {buckets: {key:number,doc_count:number}[]}) {
  const hist = Histogram;
  if (!hist)
    return;
  const field = hist.field;
  const points = agg.buckets.map(d => { return {x:d.key,y:d.doc_count}; });
  points.push({x:points[points.length-1].x+Histogram_bin_width,y:0});
  const data = {
    datasets: [{
      label: field.title,
      data: points,
      pointRadius: 0,
      showLine: true,
      steppedLine: true,
      fill: 'origin',
    }]
  };
  const xlabel = field.title + (field.units ? ' (' + field.units + ')' : '');
  Histogram_drag_start = null;
  $('#dhist').show();
  if (Histogram_chart) {
    Histogram_chart.data = data;
    (<any>Histogram_chart).options.scales.xAxes[0].scaleLabel.labelString = xlabel;
    Histogram_chart.update();
  }
  else
    Histogram_chart = new Chart('hist', {
      options: {
        maintainAspectRatio: false,
        scales: {
          xAxes: [<Chart.ChartXAxe>{
            type: 'linear',
            scaleLabel: {
              display: true,
              labelString: xlabel
            }
          }],
          yAxes: [<Chart.ChartYAxe>{
            type: 'linear',
            ticks: {
              beginAtZero: true
            },
            scaleLabel: {
              display: true,
              labelString: 'count'
            }
          }]
        },
        animation: {
          duration: 0
        },
        tooltips: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function (item) {
              return "[" + item.xLabel + "," + (<any>item.xLabel+Histogram_bin_width) + "): " + item.yLabel + "\n(drag to filter)";
            }
          }
        },
        events: ["mousedown", "mouseup", "mousemove", "mouseout", "touchstart", "touchmove", "touchend"],
        hover: {
          mode: 'index',
          intersect: false,
          onHover: function(ev, points) {
            if (ev.type === 'mouseout')
              Histogram_drag_start = null;
            else if (!points)
              return;
            else if (ev.type === 'mousedown' || ev.type === 'touchstart')
              Histogram_drag_start = getChartX(points[0]);
            else if (Histogram_drag_start && (ev.type === 'mouseup' || ev.type === 'touchend')) {
              let left = Histogram_drag_start;
              let right = getChartX(points[0]);
              if (left == right) {
                /* select one bucket? ignore? */
                return;
              }
              if (right < left) {
                left = right;
                right = Histogram_drag_start;
              }
              right += Histogram_bin_width;
              const filt = Histogram;
              if (!filt)
                return;
              filt.setRange(left, right);
            }
          }
        },
      },
      type: 'scatter',
      data: data
    });
}

function hist_toggle_log(xy: string) {
  if (!Histogram_chart)
    return;
  const axis: Chart.CommonAxe = (<any>Histogram_chart).options.scales[xy+'Axes'][0];
  // let label = <Chart.ScaleTitleOptions>axis.scaleLabel;
  if (axis.type === 'logarithmic') {
    axis.type = 'linear';
    // label.labelString = (label.labelString as string).substr(4);
  } else {
    axis.type = 'logarithmic';
    // label.labelString = 'log ' + label.labelString;
  }
  Histogram_chart.update();
}

/* elasticsearch max_result_window */
const displayLimit = 10000;

function ajax(data: any, callback: ((data: any) => void), opts: any) {
  const query: any = {
    sort: data.order.map((o: any) => {
      return (o.dir == "asc" ? '' : '-') + data.columns[o.column].data;
    }).join(' ')
  };
  for (let fi = 0; fi < Update_aggs; fi++) {
    const filt = Filters[fi];
    if (filt.query != null)
      query[filt.name] = typeof filt.query === 'object' ? filt.query.lb+','+filt.query.ub : filt.query;
  }
  if (Sample < 1) {
    query.sample = Sample;
    if (Seed != undefined)
      query.sample += '@' + Seed;
  }
  query.offset = data.start;
  query.limit = data.length;
  query.fields = TCat.columns(':visible').dataSrc().join(' ');
  const aggs = Filters.slice(Update_aggs);
  if (aggs)
    query.aggs = aggs.map((filt) => filt.name).join(' ');
  if (Histogram) {
    const hist = Histogram;
    const wid = typeof hist.query === 'object' ? <number>hist.query.ub - <number>hist.query.lb : null;
    if (wid && wid > 0) {
      Histogram_bin_width = wid/Histogram_bins;
      if (hist.field.base == "i")
        Histogram_bin_width = Math.ceil(Histogram_bin_width);
      query.hist = hist.name + ':' + Histogram_bin_width;
    }
    }
    py_text();
  $('td.loading').show();
  $.ajax({
    method: 'GET',
    url: Catalog.uri + '/catalog',
    data: query
  }).then((res: any) => {
    $('td.loading').hide();
    Catalog.count = Math.max(Catalog.count || 0, res.hits.total);
    const settings = (<any>TCat.settings())[0];
    settings.oLanguage.sInfo = "Showing _START_ to _END_ of " + settings.fnFormatNumber(res.hits.total);
    callback({
      draw: data.draw,
      recordsTotal: Catalog.count,
      recordsFiltered: Math.min(res.hits.total, displayLimit),
      data: res.hits.hits
    });
    for (let filt of aggs)
      filt.update_aggs(res.aggregations[filt.name]);
    Update_aggs = Filters.length;
    if (res.aggregations && res.aggregations.hist)
      histogram(res.aggregations.hist);
    set_download(query);
  }, (xhr, msg, err) => {
    callback({
      draw: data.draw,
      data: [],
      error: msg + ": " + err
    });
  });
}

function add_filt_row(name: string, ...nodes: Array<JQuery.htmlString | JQuery.TypeOrArray<JQuery.Node | JQuery<JQuery.Node>>>) {
  const id = 'filt-'+name;
  let tr = <HTMLTableRowElement|null>document.getElementById(id);
  if (tr) return;
  const tab = <HTMLTableElement>document.getElementById('filt');
  tr = document.createElement('tr');
  tr.id = id;
  if (tab.lastChild)
    $(tr).insertBefore(<HTMLTableRowElement>tab.lastChild);
  else
    $(tr).appendTo(tab);
  for (let node of nodes) {
    const td = $(document.createElement('td')).appendTo(tr);
    td.append(node);
  }
}

function add_sample() {
  const samp = <HTMLInputElement>document.createElement('input');
  samp.name = "sample";
  samp.type = "number";
  samp.step = "any";
  samp.min = <any>0;
  samp.max = <any>1;
  samp.value = <any>Sample;
  samp.title = "Probability (0,1] with which to include each item"

  const seed = <HTMLInputElement>document.createElement('input');
  seed.name = "seed";
  seed.type = "number";
  seed.step = <any>1;
  seed.min = <any>0;
  seed.value = <any>Seed;
  seed.disabled = true;
  seed.title = "Random seed to generate sample selection"

  samp.onchange = seed.onchange = function () {
    Sample = samp.valueAsNumber;
    if (!isFinite(Sample))
      Sample = 1;
    if (seed.disabled = Sample >= 1)
      seed.value = '';
    Seed = seed.valueAsNumber;
    if (!isFinite(Seed))
      Seed = undefined;
    TCat.draw();
  };

  add_filt_row('sample', 'random sample',
    $('<span>').append('fraction ').append(samp),
    $('<span>').append('seed ').append(seed));
}

abstract class Filter {
  name: string
  query: Query
  protected tcol: DataTables.ColumnMethods
  private label: JQuery<HTMLSpanElement>

  constructor(public field: Field) {
    this.name = this.field.name
    this.tcol = TCat.column(this.name+':name');
    this.tcol.visible(true);
    this.label = $(document.createElement('span'));
    this.label.append($('<button class="remove">&times;</button>')
      .on('click', this.remove.bind(this)),
      this.field.title);
  }

  protected add(...nodes: Array<JQuery.TypeOrArray<JQuery.Node | JQuery<JQuery.Node>>>) {
    add_filt_row(this.field.name, this.label, ...nodes);
    Filters.push(this);
    this.tcol.search('');
  }

  abstract update_aggs(aggs: Dict<any>): void;

  protected change(search: any, vis: boolean) {
    const i = Filters.indexOf(this);
    if (i >= 0 && Update_aggs > i)
      Update_aggs = i+1;
    this.tcol.search(search);
    this.tcol.visible(vis).draw();
  }

  protected remove() {
    if (!TCat) return;
    const i = Filters.indexOf(this);
    if (i < 0) return;
    Filters.splice(i, 1);
    $('tr#filt-'+this.name).remove();
    Update_aggs = i;
    this.tcol.search('');
    this.tcol.visible(true).draw();
  }

}

class SelectFilter extends Filter {
  select: HTMLSelectElement

  constructor(field: Field) {
    super(field);

    this.select = document.createElement('select');
    this.select.name = this.field.name;
    this.select.disabled = true;
    this.select.onchange = this.change.bind(this);
    this.add(this.select);
  }

  update_aggs(aggs: Dict<any>) {
    $(this.select).empty();
    this.select.appendChild(document.createElement('option'));
    for (let b of aggs.buckets) {
      const opt = document.createElement('option');
      opt.setAttribute('value', b.key);
      if (this.field.enum)
          b.key = this.field.enum[b.key];
      opt.textContent = b.key + ' (' + b.doc_count + ')';
      this.select.appendChild(opt);
    }
    this.select.value = '';
    this.select.disabled = false;
  }

  protected change() {
    const val = this.select.value;
    if (val)
      this.query = val;
    else
      this.query = undefined;
    super.change(val, !val);
  }
}

class NumericFilter extends Filter {
  lb: HTMLInputElement
  ub: HTMLInputElement
  private avg: HTMLSpanElement

  private makeBound(w: boolean): HTMLInputElement {
    const b = <HTMLInputElement>document.createElement('input');
    b.name = this.name+"."+(w?"u":"l")+"b";
    b.title = (w?"Upper":"Lower")+" bound for " + this.field.title + " values"
    b.type = "number";
    b.step = this.field.base == "i" ? <any>1 : "any";
    b.disabled = true;
    b.onchange = this.change.bind(this);
    return b;
  }

  constructor(field: Field) {
    super(field);

    this.lb = this.makeBound(false);
    this.ub = this.makeBound(true);
    this.avg = document.createElement('span');
    this.avg.innerHTML = "<em>loading...</em>";
    this.add(
      $('<span>').append(this.lb).append(' &ndash; ').append(this.ub),
      $('<span><em>&mu;</em> = </span>').append(this.avg),
      $('<button>histogram</button>').on('click', this.histogram.bind(this))
    );
  }

  update_aggs(aggs: Dict<any>) {
    this.query = { lb: aggs.min, ub: aggs.max };
    this.lb.defaultValue = this.lb.value = this.lb.min = this.ub.min = aggs.min;
    this.ub.defaultValue = this.ub.value = this.lb.max = this.ub.max = aggs.max;
    this.lb.disabled = this.ub.disabled = false;
    this.avg.textContent = aggs.avg;
  }

  protected change() {
    const lbv = this.lb.valueAsNumber;
    const ubv = this.ub.valueAsNumber;
    if (lbv == ubv)
      this.query = lbv;
    else
      this.query = {
        lb:isFinite(lbv) ? lbv : this.lb.defaultValue,
        ub:isFinite(ubv) ? ubv : this.ub.defaultValue
      };
    super.change(lbv+" TO "+ubv, lbv!=ubv);
  }

  private histogram() {
    if (Histogram !== this) {
      Histogram = this;
      this.tcol.draw(false);
    }
  }

  protected remove() {
    super.remove();
    if (Histogram === this) {
      Histogram = undefined;
      $('#dhist').hide();
    }
  }

  setRange(lbv: number, ubv: number) {
    this.lb.valueAsNumber = lbv;
    this.ub.valueAsNumber = ubv;
    this.change();
  }
}

function add_filter(idx: number): Filter|undefined {
  const field = Catalog.fields[idx];
  if (!TCat || !field || Filters.some((f) => f.field === field))
    return;
  if (field.terms)
    return new SelectFilter(field);
  return new NumericFilter(field);
}

(<any>window).hide_column = function hide_column(event:Event) {
  if (TCat) {
    TCat.column((<HTMLElement>event.target).id.substr(5)+':name').visible(false);
    set_download();
  }
  event.stopPropagation();
  return false;
};

function py_text() {
    var st = '';
    var cat = Catalog.uri.substring(Catalog.uri.indexOf('/') + 1, );
    for (let i = 0; i < Filters.length; i++) {
        if (Filters[i] instanceof NumericFilter) {
            st += ", " + Filters[i].name + ' = ('
            if (typeof (Filters[i].query) != 'undefined')
                st += Filters[i].query['lb'] + ', ' + Filters[i].query['ub'];
            st += ')';
        }
    }
    st = "from client import * <br>" + cat + " = Simulation('" + cat + "') <br>" + "q = Query(" + cat + st;
    if (Seed != 'undefined')
        st += ", seed = " + Seed;
    if (Sample != 1)
        st += ", sample = " + Sample;
    st += ') <br> dat = q.numpy()';
    document.getElementById('py').innerHTML = st;
    return;
}


function render_funct(field: Field): (any) => string {
    if (field.base === 'f')
        return function (data) {
            if (data != undefined)
                return data.toPrecision(8);
        }
    if (field.enum)
        return function (data) {
            if (data != undefined)
                return field.enum[data];
        }
    return  (data)=> {
        return data;
    }
}

function init() {
  Update_aggs = 0;
  const table = $('table#tcat');
  if (!(<any>window).Catalog || !table.length)
    return;
  for (let i = 0; i < Catalog.fields.length; i++)
    Fields_idx[Catalog.fields[i].name] = i;
  const topts: DataTables.Settings = {
    serverSide: true,
    ajax: ajax,
    deferLoading: 1,
    scrollX: true,
    pageLength: 25,
    processing: true,
    dom: 'i<"#download">rtlp',
    deferRender: true,
    pagingType: 'simple', 
    columns: Catalog.fields.map((c) => {
        return {
          render: render_funct(c),
          name: c.name };
      }) 


  };
  if ((<any>window).Query) {
    if (Query.offset)
      topts.displayStart = Query.offset
    if (Query.limit)
      topts.pageLength = Query.limit;
    if (Query.sort)
      topts.order = Query.sort.map((o) => {
        return [Fields_idx[o.field], o.asc ? 'asc' : 'desc'];
      });
    if (Query.fields && Query.fields.length && topts.columns)
      for (let c of topts.columns)
        c.visible = Query.fields.indexOf(<string>c.name) >= 0;
  }
  TCat = table.DataTable(topts);
  /* for debugging: */
  (<any>window).TCat = TCat;

  const addfilt = <HTMLSelectElement>document.createElement('select');
  addfilt.appendChild(document.createElement('option'));
  add_filt_row('', addfilt, 'Select field to view/filter');
  for (let i = 0; i < Catalog.fields.length; i++) {
    let f = Catalog.fields[i];
    let opt = document.createElement('option');
    opt.setAttribute('value', i.toString());
    opt.textContent = f.title;
    if (f.descr)
      opt.setAttribute('title', f.descr);
    addfilt.appendChild(opt);
    if (f.top)
      add_filter(i);
  }
  addfilt.onchange = function () {
    add_filter(<any>addfilt.value);
    TCat.draw(false);
  };
  add_sample();
  TCat.draw();

  for (let xy of "xy")
    $('#dhist-'+xy+'-tog').on('click', hist_toggle_log.bind(undefined, xy));
}

$(init);
