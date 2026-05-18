import React from "react";
import img1 from "../assets/campus/campus1.jpg";
import img2 from "../assets/campus/campus2.jpg";
import img3 from "../assets/campus/campus3.jpg";
import img4 from "../assets/campus/campus4.jpg";
import img5 from "../assets/campus/campus5.jpg";
import img6 from "../assets/campus/campus6.jpg";



const images = [img1, img2, img3, img4, img5, img6];

const Gallery = () => {
  return (
    <div className="min-h-screen bg-gray-100 py-10 px-6">
      <h1 className="text-4xl font-bold text-center mb-10 text-blue-600">
        Campus Gallery
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {images.map((image, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-2xl shadow-lg bg-white"
          >
            <img
              src={image}
              alt="gallery"
              className="w-full h-72 object-cover hover:scale-105 transition duration-300"
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default Gallery;