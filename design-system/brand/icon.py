import math
from PIL import Image, ImageDraw, ImageFilter, ImageChops
from sparkle import star, glow, EYE
img=Image.open('shrike.jpeg').convert('RGB'); mask=Image.open('mask.png').convert('L').resize(img.size)
x0,y0,x1,y1=mask.point(lambda v:255 if v>128 else 0).getbbox()
def lerp(a,b,t): t=max(0,min(1,t)); return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
CYAN=(63,231,255); BLUE=(47,123,255); VIOLET=(139,92,246)  # design-system tokens: cyan, blue, violet (Abyss)
def grad(t): return lerp(CYAN,BLUE,t*1.8) if t<.55 else lerp(BLUE,VIOLET,(t-.55)/.45)
pad=4; box=(x0-pad,y0-pad,x1+pad,int(y0+(y1-y0)*0.42)); bw=box[2]-box[0]; bh=box[3]-box[1]
def dots(gw, gamma=0.75):
    gh=int(round(bh*gw/bw)); b=img.crop(box); m=mask.crop(box)
    g=b.convert('L').resize((gw,gh),Image.LANCZOS); mm=m.resize((gw,gh),Image.LANCZOS)
    ins=mm.point(lambda v:255 if v>128 else 0)
    vals=[g.getpixel((x,y)) for y in range(gh) for x in range(gw) if ins.getpixel((x,y))]
    lo,hi=min(vals),max(vals)
    g=g.point(lambda v:int(255*((max(lo,min(hi,v))-lo)/max(1,hi-lo))**gamma))
    d=g.convert('1'); edge=ImageChops.subtract(ins,ins.filter(ImageFilter.MinFilter(3)))
    on=[[bool(ins.getpixel((x,y)) and (edge.getpixel((x,y)) or d.getpixel((x,y)))) for x in range(gw)] for y in range(gh)]
    return on,gw,gh
def icon(size, gw, sparkle=True, squircle=True, name=None, bg=(6,11,24)):
    S=4; W=size*S
    im=Image.new('RGBA',(W,W),(0,0,0,0)); d=ImageDraw.Draw(im)
    if squircle:
        inset=int(W*0.098); r=int(W*0.225)
        d.rounded_rectangle((inset,inset,W-inset,W-inset),r,fill=bg+(255,))
        nv=Image.new('RGBA',(W,W),(0,0,0,0)); nd=ImageDraw.Draw(nv)
        for i in range(30,0,-1):
            t=i/30; nd.ellipse((W/2-W*0.42*t,W*0.40-W*0.42*t,W/2+W*0.42*t,W*0.40+W*0.42*t),fill=(10,22,51,int(150*(1-t))))
        msk=Image.new('L',(W,W),0); ImageDraw.Draw(msk).rounded_rectangle((inset,inset,W-inset,W-inset),r,fill=255)
        im.paste(Image.alpha_composite(im,nv),(0,0),msk); d=ImageDraw.Draw(im)
        # faint inner rim
        d.rounded_rectangle((inset,inset,W-inset,W-inset),r,outline=(255,255,255,18),width=max(1,W//256))
        area=(inset+W*0.07, inset+W*0.06, W-inset-W*0.07, W-inset-W*0.02)
    else: area=(W*0.04,W*0.04,W*0.96,W*0.96)
    on,gw,gh=dots(gw)
    aw=area[2]-area[0]; ah=area[3]-area[1]; p=min(aw/gw, ah/gh)
    ox=area[0]+(aw-gw*p)/2; oy=area[3]-gh*p  # bust sits on the bottom edge of the area
    rr=p*0.40
    for y in range(gh):
        for x in range(gw):
            if on[y][x]:
                c=grad(y/gh); cx,cy=ox+x*p+p/2, oy+y*p+p/2
                d.ellipse((cx-rr,cy-rr,cx+rr,cy+rr),fill=c+(255,))
    if sparkle:
        ex=ox+(EYE[0]-box[0])*(gw/bw)*p; ey=oy+(EYE[1]-box[1])*(gw/bw)*p
        sc=W/1024
        g=glow(int(260*sc),70*sc,(120,230,255),235); im.alpha_composite(g,(int(ex-g.width/2),int(ey-g.height/2)))
        s=star(int(170*sc),46*sc,0.25,(255,255,255,255)); sb=s.filter(ImageFilter.GaussianBlur(5*sc))
        im.alpha_composite(sb,(int(ex-s.width/2),int(ey-s.height/2))); im.alpha_composite(s,(int(ex-s.width/2),int(ey-s.height/2)))
        d=ImageDraw.Draw(im); cr=6*sc; d.ellipse((ex-cr,ey-cr,ex+cr,ey+cr),fill=(255,255,255,255))
    out=im.resize((size,size),Image.LANCZOS)
    if name: out.save(name)
    return out
# grid density per size: big sizes keep fine dots, small sizes fewer bigger dots
icon(1024,64,name='theme-icon-1024.png')
for s,gw in ((512,56),(256,44),(128,34),(64,24),(32,16),(16,11)):
    icon(s,gw,sparkle=s>=64,name=f'theme-icon-{s}.png')
icon(1024,64,squircle=False,name='theme-mark-1024.png')
icon(1024,64,squircle=False,sparkle=False,name='theme-mark-still-1024.png')
# preview sheet: big + dock row
sheet=Image.new('RGB',(1500,620),(28,28,32))
sheet.paste(Image.open('theme-icon-1024.png').resize((560,560)),(20,30),Image.open('theme-icon-1024.png').resize((560,560)))
x=620
for s in (256,128,64,32,16):
    im=Image.open(f'theme-icon-{s}.png'); sheet.paste(im,(x,310-s//2),im); x+=s+40
sheet.save('theme-icon-sheet.png'); print('ok')
