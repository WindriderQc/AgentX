// Calendar scale changes preserve a selected moment's day. Panning beyond
// that anchor deliberately switches back to the visible window's centre.
export function scaleCenter(range,domain,anchor,selectedTime){
 if(Number.isFinite(selectedTime))return selectedTime;
 if(Number.isFinite(anchor)&&((range[1]-range[0])/(domain[1]-domain[0])>.98||anchor>=range[0]&&anchor<range[1]))return anchor;
 return (range[0]+range[1])/2;
}
