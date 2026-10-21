/* External reference links; no listing content is copied or harvested here. */
(function(){
  'use strict';
  const teams={'Aston Villa':'aston-villa','Arsenal':'arsenal','Bournemouth':'bournemouth','Chelsea':'chelsea','Crystal Palace':'crystal-palace','Everton':'everton','Fulham':'fulham','Leeds United':'leeds-united','Liverpool':'liverpool','Manchester City':'manchester-city','Manchester United':'manchester-united','Newcastle United':'newcastle-united','Nottingham Forest':'nottingham-forest','Sunderland':'sunderland','Tottenham Hotspur':'tottenham-hotspur'};
  function linksFor(fixture,selectedTeam=''){
    if(!Number.isFinite(fixture?.startsAt))return [];
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(fixture.startsAt).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const date=parts.year+'-'+parts.month+'-'+parts.day;
    const team=teams[selectedTeam]?selectedTeam:[fixture.home,fixture.away].find(t=>teams[t]);
    const bbc=team?'https://www.bbc.co.uk/sport/football/teams/'+teams[team]+'/scores-fixtures/'+date.slice(0,7):'https://www.bbc.co.uk/sport/football/scores-fixtures/'+date;
    const villaCity=fixture.home==='Aston Villa'&&fixture.away==='Manchester City'&&date==='2026-10-24';
    return [
      {label:'BBC fixtures',url:bbc},
      {label:'Worldwide TV guide',url:villaCity?'https://www.livesoccertv.com/match/aston-villa-vs-manchester-city/17ig5':'https://www.livesoccertv.com/schedules/'+date+'/'},
      {label:'UK TV guide',url:fixture.home==='Aston Villa'||fixture.away==='Aston Villa'?'https://www.live-footballontv.com/aston-villa-on-tv.html':'https://www.live-footballontv.com/'}
    ];
  }
  window.SameEndListingSources={linksFor};
})();
