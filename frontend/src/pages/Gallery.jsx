
import React, { useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/plugins/counter.css";

import img1 from "../assets/campus/campus1.jpg";
import img2 from "../assets/campus/campus2.jpg";
import img3 from "../assets/campus/campus3.jpg";
import img4 from "../assets/campus/campus4.jpg";
import img5 from "../assets/campus/campus5.jpg";
import img6 from "../assets/campus/campus6.jpg";

const imagesArray = [img1, img2, img3, img4, img5, img6];
const slides = imagesArray.map((img) => ({ src: img }));

const Gallery = () => {
  const [open, setOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  return (
    <>
      <div className="min-h-screen bg-gray-100 py-10 px-6">
        <h1 className="text-4xl font-bold text-center mb-10 text-blue-600">
          Campus Gallery
        </h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {imagesArray.map((image, index) => (
            <div
              key={index}
              className="group relative overflow-hidden rounded-2xl shadow-lg bg-white cursor-pointer"
              onClick={() => {
                setCurrentIndex(index);
                setOpen(true);
              }}
            >
              <img
                src={image}
                alt="gallery"
                className="w-full h-72 object-cover transition duration-300 group-hover:scale-105"
              />
              <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition duration-300">
                <span className="bg-black/60 text-white p-2 rounded-full text-xl">
                  ⛶
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Lightbox
        open={open}
        close={() => setOpen(false)}
        index={currentIndex}
        slides={slides}
        plugins={[Fullscreen, Zoom, Counter]}  
        counter={{ container: { style: { top: "20px", left: "20px" } } }}
      />
    </>
  );
};

export default Gallery;