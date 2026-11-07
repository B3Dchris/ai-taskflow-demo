"""Draw the JitsFlow app icons (a black belt with its red bar on brand blue)."""
from PIL import Image, ImageDraw
import os
OUT=os.path.join(os.path.dirname(__file__),'..','web','icons')
def icon(size,pad=0.0,round_=False):
    im=Image.new('RGBA',(size,size),(0,0,0,0));d=ImageDraw.Draw(im)
    bg=(29,79,181,255)
    if round_: d.rounded_rectangle([0,0,size-1,size-1],radius=int(size*0.22),fill=bg)
    else: d.rectangle([0,0,size,size],fill=bg)
    s=size*(1-2*pad);o=size*pad
    y0=o+s*0.40;y1=o+s*0.60
    d.rectangle([o+s*0.06,y0,o+s*0.94,y1],fill=(20,20,20,255))            # belt
    d.rectangle([o+s*0.60,y0,o+s*0.82,y1],fill=(196,38,30,255))            # red bar
    for i in range(2): x=o+s*(0.65+i*0.08); d.rectangle([x,y0,x+s*0.03,y1],fill=(244,244,240,255))  # stripes
    d.rounded_rectangle([o+s*0.24,o+s*0.33,o+s*0.40,o+s*0.67],radius=int(s*0.03),fill=(20,20,20,255),outline=(244,244,240,255),width=max(2,int(s*0.012)))  # knot
    return im
icon(512).save(os.path.join(OUT,'icon-512.png'))
icon(192).save(os.path.join(OUT,'icon-192.png'))
icon(180).convert('RGB').save(os.path.join(OUT,'apple-touch-icon.png'))
icon(512,pad=0.12).save(os.path.join(OUT,'icon-maskable-512.png'))
icon(64,round_=True).save(os.path.join(OUT,'favicon.png'))
print('icons written')
