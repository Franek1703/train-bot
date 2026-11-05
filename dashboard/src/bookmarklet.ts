// Bookmarklet run on ebilet.intercity.pl "Twoja podróż". The page keeps the selected train in
// sessionStorage (choiceOfPlacesInitialData), which is not part of the URL. We send URL + train
// to the dashboard through the hash fragment; the backend confirms it against Intercity's list.
export interface IncomingJourney {
  url: string;
  train?: { trainNumber: string; departureTime: string; date: string };
}

export function buildBookmarklet(dashboardOrigin: string): string {
  const code = `(function(){try{
var s=JSON.parse(sessionStorage.getItem('choiceOfPlacesInitialData')||'null');
var t=s&&s.from&&s.from.pociagi;
if(!t||!t.length){alert('Train Bot: otwórz stronę „Twoja podróż” z wybranym pociągiem.');return}
if(t.length>1){alert('Train Bot: połączenia z przesiadką nie są obsługiwane.');return}
t=t[0];var d=String(t.dataWyjazdu);
var p={url:location.href,train:{trainNumber:t.kategoriaPociagu+' '+t.nrPociagu,departureTime:d.slice(11,16),date:d.slice(0,10)}};
window.open(${JSON.stringify(dashboardOrigin)}+'/#journey='+btoa(JSON.stringify(p)),'trainbot');
}catch(e){alert('Train Bot: '+e.message)}})()`;
  return 'javascript:' + code.replace(/\n/g, '');
}

export function readIncomingJourney(hash: string): IncomingJourney | undefined {
  const match = hash.match(/^#journey=([A-Za-z0-9+/=_-]+)$/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(atob(match[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as IncomingJourney;
    return typeof value.url === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
