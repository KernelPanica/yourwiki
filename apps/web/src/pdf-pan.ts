type Point={id:number;x:number;y:number};
type Bounds={left:number;top:number;width:number;height:number;scrollLeft:number;scrollTop:number};
export class PdfPan {
 private drag:(Point&{left:number;top:number})|null=null;
 begin(input:Point&{button:number;type:string},bounds:Bounds){
  if(this.drag||input.type==='touch'||input.button!==0||input.x<bounds.left||input.y<bounds.top||input.x>=bounds.left+bounds.width||input.y>=bounds.top+bounds.height)return false;
  this.drag={id:input.id,x:input.x,y:input.y,left:bounds.scrollLeft,top:bounds.scrollTop};return true;
 }
 move(input:Point){return this.drag?.id===input.id?{left:this.drag.left+this.drag.x-input.x,top:this.drag.top+this.drag.y-input.y}:null;}
 end(id:number){if(this.drag?.id!==id)return false;this.drag=null;return true;}
 reset(){this.drag=null;}
}
